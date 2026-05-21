import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { networkInterfaces } from 'os';
import crypto from 'crypto';
import { mkdir, readFile, writeFile, rename, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getAllTargets, pokeTarget, memflowPollResponses, memflowMarkAsRead, memflowReadInbox, memflowWriteResponse } from './connectors/index.mjs';

const APP_VERSION = '2.0.0';
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const LOGS_DIR = join(__dirname, '.logs');
const LOG_FILE = join(LOGS_DIR, `ag-bridge-${new Date().toISOString().split('T')[0]}.log`);
const STATE_FILE = join(DATA_DIR, 'state.json');
const APPROVALS_FILE = join(DATA_DIR, 'approvals.json');
const POLICY_FILE = join(__dirname, 'policy.json');
let POLICY = { version: 2, profiles: { relaxed: { allow: [".*"] }, balanced: { allow: [] } }, globalDeny: [] };

// --- Config ---
const args = process.argv.slice(2);
const getArg = (name) => {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : null;
};
const hasArg = (name) => args.includes(name);

const PORT = parseInt(getArg('--port') || process.env.PORT || '8787');
const HOST = getArg('--host') || '0.0.0.0';

export const app = express();
export const server = createServer(app);
// Don't bind 'server' here so we can handle upgrade manually for auth
export const wss = new WebSocketServer({ noServer: true });

// --- Poke Logic ---
let pokeInFlight = false;
let lastPokeAt = 0;
let retryTimer = null;
let retryAttempts = 0;

async function runPokeScript() {
    // Find ALL "new" messages for the agent
    const pendingMsgs = STATE.messages
        .filter(m => m.to === 'agent' && m.status === 'new')
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    if (pendingMsgs.length === 0) {
        log('POKE', 'No new messages to deliver.');
        return { ok: true, method: 'no_messages' };
    }

    // 1. Resolve project name from the message targetId
    const rawTarget = pendingMsgs[0].targetId || STATE.targetProject?.projectName || STATE.targetProject?.title || 'global';
    const finalProjectName = typeof rawTarget === 'string' ? rawTarget : (rawTarget?.projectName || rawTarget?.title || 'global');

    // 2. Build combined message text
    const msgText = pendingMsgs.map(m => m.text).join('\n\n')
        + `\n\n<system_note>Important: The user sent this message from the [${finalProjectName}] workspace. You MUST restrict your actions to this project. Ignore your active document metadata if it belongs to a different project. Send your response using the mobile_respond MCP tool. Provide regular status updates using http://127.0.0.1:8787/agent/status {"state": "working", "task": "..."}. Do not just reply in the local chat panel.</system_note>`;

    log('POKE', `Delivering ${pendingMsgs.length} messages (${msgText.length} chars) for project: ${finalProjectName}`);

    const pokeMetadata = { project: finalProjectName, from: 'user', to: 'agent', channel: 'work' };
    let delivered = false;

    // =====================================================
    // STEP 1: MemFlow Write (PRIMARY — this IS delivery)
    // =====================================================
    try {
        const mfResult = await pokeTarget({ connectorId: 'memflow' }, msgText, pokeMetadata);
        if (mfResult.ok) {
            delivered = true;
            log('POKE', `MemFlow delivery: SUCCESS (${mfResult.method || 'sqlite'})`);
            // Messages are DELIVERED — mark immediately
            pendingMsgs.forEach(m => {
                m.status = 'poked';
                broadcast('message_ack', { id: m.id, status: 'poked' });
            });
            saveState();
            log('POKE', `Marked ${pendingMsgs.length} messages as poked via MemFlow.`);
        } else {
            log('POKE', 'MemFlow delivery: write returned not ok', mfResult);
        }
    } catch (e) {
        log('POKE', `MemFlow delivery error: ${e.message}`);
    }

    // =====================================================
    // STEP 2: CDP Notification (OPTIONAL — just wakes agent)
    // =====================================================
    try {
        const targets = await getAllTargets();
        if (targets.length > 0) {
            const exactMatch = targets.find(t =>
                t.projectName === finalProjectName ||
                (t.title && t.title.includes(finalProjectName))
            );
            const cdpTarget = exactMatch || targets[0];
            log('POKE', `CDP notify -> ${cdpTarget.title || cdpTarget.id} (port ${cdpTarget.port})`);

            const cdpResult = await pokeTarget(cdpTarget, msgText, pokeMetadata);
            if (cdpResult.ok) {
                log('POKE', `CDP notify: SUCCESS (${cdpResult.method})`);
                if (!delivered) {
                    // MemFlow failed but CDP worked — mark delivered via CDP fallback
                    delivered = true;
                    pendingMsgs.forEach(m => {
                        m.status = 'poked';
                        broadcast('message_ack', { id: m.id, status: 'poked' });
                    });
                    saveState();
                    log('POKE', `Marked ${pendingMsgs.length} messages as poked via CDP fallback.`);
                }
            } else {
                log('POKE', `CDP notify: ${cdpResult.reason || cdpResult.error || 'failed'} (non-fatal, MemFlow is primary)`);
            }
        } else {
            log('POKE', 'CDP notify: No IDE targets found (non-fatal)');
        }
    } catch (e) {
        log('POKE', `CDP notify error (non-fatal): ${e.message}`);
    }

    // Update agent status
    if (delivered) {
        STATE.agent.state = 'working';
        STATE.agent.lastSeen = new Date().toISOString();
        saveState();
        broadcast('agent_status', STATE.agent);
        stopRetry();
    }

    return delivered
        ? { ok: true, method: 'memflow_primary' }
        : { ok: false, error: 'all_delivery_failed' };
}

function stopRetry() {
    if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
    }
    retryAttempts = 0;
}

function startRetry() {
    if (retryTimer) return;
    retryAttempts = 0;
    log('POKE', 'Agent busy. Starting retry loop...');
    retryTimer = setInterval(async () => {
        retryAttempts++;
        if (retryAttempts > 24) { // 2 minutes
            log('POKE', 'Retry limit reached. Giving up.');
            stopRetry();
            return;
        }
        await tryPoke(true);
    }, 5000);
}

async function tryPoke(isRetry = false) {
    if (pokeInFlight) return;

    // Throttle 2s
    if (Date.now() - lastPokeAt < 2000) return;

    pokeInFlight = true;
    lastPokeAt = Date.now();

    if (!isRetry) log('POKE', 'Attempting message delivery...');
    let res;
    try {
        res = await runPokeScript();
    } catch (e) {
        log('POKE', 'Fatal error during poke', e.message);
        res = { ok: false, error: 'fatal_error', details: e.message };
    } finally {
        pokeInFlight = false;
    }

    if (res.ok) {
        log('POKE', `Delivery complete: ${res.method}`);
        // runPokeScript already handles agent state and stopRetry
    } else {
        log('POKE', 'Delivery failed', res);
        // Don't retry if MemFlow is working — the message is persisted there
        stopRetry();
    }
}

function schedulePoke() {
    if (pokeInFlight) return;

    // Dedupe: If we are already retrying, we don't need to kickstart it.
    // However, if we aren't retrying, and a poke is not in flight, we should try.
    // The throttle in tryPoke handles the "too fast" case.
    if (retryTimer) {
        log('POKE', 'Skipping schedulePoke: Retry loop already active.');
        return;
    }

    tryPoke(false);
}

// --- State ---
// Persistent State
let STATE = {
    version: 1,
    strictMode: true,
    approvals: [],
    messages: [],
    agent: { state: 'idle', lastSeen: null, task: '', note: '' },
    checkpoints: [],
    tokens: [], // Changed from optional to persisted for UX stability
    pairingCode: null
};

// Ephemeral State
let PAIRING_CODE = generateCode();
let TOKENS = new Set(); // Loaded from STATE.tokens

// --- Helpers ---
function generateCode() {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    try {
        const { writeFileSync } = require('fs');
        writeFileSync(join(DATA_DIR, 'code.txt'), code);
    } catch (e) {
        // use dynamic import for fs/promises if sync fails in module
        import('fs/promises').then(fs => fs.writeFile(join(DATA_DIR, 'code.txt'), code)).catch(()=>{});
    }
    return code;
}

function generateToken() {
    return crypto.randomBytes(16).toString('hex');
}

function getLocalIPs() {
    const nets = networkInterfaces();
    const results = new Set();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            // Skip internal (non-127.0.0.1) and non-IPv4
            if (net.family === 'IPv4' && !net.internal) {
                // Filter out Tailscale IPs (100.x.x.x) from the "Local" list
                if (!net.address.startsWith('100.')) {
                    results.add(net.address);
                }
            }
        }
    }
    return Array.from(results);
}

function getTailscaleInfo() {
    // Try standard PATH first, then fallback to Mac App Store location
    const cmds = [
        'tailscale status --json',
        '/Applications/Tailscale.app/Contents/MacOS/Tailscale status --json'
    ];
    
    for (const cmd of cmds) {
        try {
            const stdout = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
            const status = JSON.parse(stdout);
            if (status.BackendState === 'Running') {
                const dnsName = status.Self.DNSName;
                const name = dnsName ? dnsName.replace(/\.$/, '') : null;
                const ips = status.TailscaleIPs || [];
                return { name, ips };
            }
        } catch (e) {
            // continue to next cmd
        }
    }
    return null;
}

function broadcast(event, payload) {
    const msg = JSON.stringify({
        event,
        payload,
        ts: new Date().toISOString()
    });
    for (const client of wss.clients) {
        if (client.readyState === 1) { // OPEN
            client.send(msg);
        }
    }
}

// --- Logging ---
async function log(component, message, data = null) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${component}] ${message} ${data ? JSON.stringify(data) : ''}`;
    console.log(line);
    try {
        await appendFile(LOG_FILE, line + '\n');
    } catch (e) { /* ignore log errors */ }
}

// --- Persistence ---
let saveTimeout = null;
async function saveState() {
    if (saveTimeout) clearTimeout(saveTimeout);

    saveTimeout = setTimeout(async () => {
        try {
            const data = {
                version: STATE.version,
                strictMode: STATE.strictMode,
                // approvals: STATE.approvals, // Scoped to approvals.json now
                messages: STATE.messages,
                agent: STATE.agent,
                checkpoints: STATE.checkpoints,
                tokens: Array.from(TOKENS),
                pairingCode: STATE.pairingCode
            };
            const tempFile = `${STATE_FILE}.tmp`;
            await writeFile(tempFile, JSON.stringify(data, null, 2));
            await rename(tempFile, STATE_FILE);
            log('PERSIST', 'State saved (config/msgs).');
        } catch (err) {
            log('PERSIST', 'Failed to save state:', err.message);
        }
    }, 250);
}

async function saveApprovals() {
    try {
        const tempFile = `${APPROVALS_FILE}.tmp`;
        await writeFile(tempFile, JSON.stringify(STATE.approvals, null, 2));
        await rename(tempFile, APPROVALS_FILE);
        log('PERSIST', `Approvals saved (${STATE.approvals.length}).`);
    } catch (err) {
        log('PERSIST', 'Failed to save approvals:', err.message);
    }
}

async function loadPolicy() {
    try {
        const raw = await readFile(POLICY_FILE, 'utf-8');
        POLICY = JSON.parse(raw);
        log('POLICY', 'Loaded policy.json');
    } catch (err) {
        log('POLICY', 'policy.json not found or invalid. Using defaults.');
    }
}

async function loadState() {
    try {
        await mkdir(DATA_DIR, { recursive: true });
        const raw = await readFile(STATE_FILE, 'utf-8');
        const data = JSON.parse(raw);

        if (data.version) STATE.version = data.version;
        if (typeof data.strictMode === 'boolean') STATE.strictMode = data.strictMode;
        // if (Array.isArray(data.approvals)) STATE.approvals = data.approvals; // Legacy load
        if (Array.isArray(data.messages)) STATE.messages = data.messages;
        if (data.agent) STATE.agent = data.agent;
        if (Array.isArray(data.checkpoints)) STATE.checkpoints = data.checkpoints;
        if (Array.isArray(data.tokens)) {
            STATE.tokens = data.tokens;
            TOKENS = new Set(data.tokens);
        }
        if (data.pairingCode) {
            STATE.pairingCode = data.pairingCode;
            PAIRING_CODE = data.pairingCode;
            try {
                const { writeFileSync } = await import('fs');
                writeFileSync(join(DATA_DIR, 'code.txt'), PAIRING_CODE);
            } catch (e) {
                // ignore
            }
        } else {
            STATE.pairingCode = PAIRING_CODE; // whatever was generated at startup
            saveState();
        }

        // Load Approvals (Separate File)
        try {
            const rawApprovals = await readFile(APPROVALS_FILE, 'utf-8');
            const approvalsData = JSON.parse(rawApprovals);
            if (Array.isArray(approvalsData)) {
                STATE.approvals = approvalsData;
            }
        } catch (e) {
            if (e.code === 'ENOENT') {
                // Migration: Check if state.json had approvals
                if (Array.isArray(data.approvals) && data.approvals.length > 0) {
                    log('PERSIST', 'Migrating approvals from state.json to approvals.json');
                    STATE.approvals = data.approvals;
                    await saveApprovals();
                }
            } else {
                log('PERSIST', 'Failed to load approvals.json', e.message);
            }
        }

        console.log(`[PERSIST] State loaded. ${STATE.approvals.length} approvals, ${TOKENS.size} tokens.`);
    } catch (err) {
        if (err.code === 'ENOENT') {
            log('PERSIST', 'No state file found. Starting fresh.');
            await saveState();
        } else {
            log('PERSIST', 'Failed to load state:', err.message);
            // Logic to rename bad file could go here, but simple logging is fine for v0.2
            const badFile = `${STATE_FILE}.bad.${Date.now()}`;
            try {
                await rename(STATE_FILE, badFile);
                log('PERSIST', `Corrupt state file renamed to ${badFile}`);
            } catch (e) { /* ignore */ }
        }
    }
}

function checkPolicy(cmd) {
    if (!cmd) return { allowed: false, error: 'missing_command' };

    // 1. Global Deny (Always wins)
    for (const pattern of POLICY.globalDeny || []) {
        if (new RegExp(pattern).test(cmd)) {
            return { allowed: false, error: 'global_denied' };
        }
    }

    // 2. Determine Profile (Map v0.5 boolean to v0.6 profiles)
    // strictMode=true -> 'balanced', strictMode=false -> 'relaxed'
    // Future: STATE.securityProfile could hold 'paranoid' etc.
    const profileName = STATE.strictMode ? 'balanced' : 'relaxed';
    const profile = POLICY.profiles?.[profileName];

    if (!profile) {
        // Fallback safety: if profile invalid, BLOCK ALL unless relaxed was intended?
        // Better to be safe.
        return { allowed: false, error: 'invalid_policy_profile' };
    }

    // 3. Profile Deny
    for (const pattern of profile.deny || []) {
        if (new RegExp(pattern).test(cmd)) {
            return { allowed: false, error: 'profile_denied' };
        }
    }

    // 4. Profile Allow
    for (const pattern of profile.allow || []) {
        if (new RegExp(pattern).test(cmd)) {
            return { allowed: true };
        }
    }

    return { allowed: false, error: 'command_not_allowlisted' };
}

// --- Middleware ---
app.use(express.json());

// HTTPS redirect: if request arrives on raw port 8787 without going through
// tailscale serve (which injects X-Forwarded-Proto: https), redirect to https.
// Localhost and MCP clients are exempt.
let _tailscaleHostname = null;
function getTailscaleHostname() {
    if (_tailscaleHostname) return _tailscaleHostname;
    const ts = getTailscaleInfo();
    _tailscaleHostname = ts ? ts.name : null;
    return _tailscaleHostname;
}
app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || '';
    const isLocal = ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.');
    const isHttps = req.headers['x-forwarded-proto'] === 'https';
    // Only redirect non-local, non-HTTPS GET/HEAD requests (not API calls with tokens)
    if (!isLocal && !isHttps && (req.method === 'GET' || req.method === 'HEAD')) {
        const hostname = getTailscaleHostname();
        if (hostname) {
            const url = `https://${hostname}${req.originalUrl}`;
            log('HTTPS', `Redirecting ${ip} to ${url}`);
            return res.redirect(301, url);
        }
    }
    next();
});

app.use(express.static('public'));

const requireAuth = (req, res, next) => {
    // Allow localhost (MCP server) to bypass auth
    const ip = req.ip || req.connection.remoteAddress;
    if (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') {
        return next();
    }

    const token = req.headers['x-ag-token'];
    if (!token || !TOKENS.has(token)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

const checkAuth = requireAuth; // Alias for consistency with new endpoints

// --- HTTP Endpoints ---

// Public
app.get('/health', (req, res) => {
    res.json({ ok: true, name: "ag_bridge", version: APP_VERSION, ts: new Date().toISOString() });
});

app.get('/debug/code', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') {
        res.json({ code: PAIRING_CODE });
    } else {
        res.status(403).json({ error: 'localhost_only' });
    }
});

const claimAttempts = new Map();
app.post('/pair/claim', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const attempt = claimAttempts.get(ip) || { count: 0, time: now };
    
    // Reset after 10 minutes
    if (now - attempt.time > 10 * 60 * 1000) {
        attempt.count = 0;
        attempt.time = now;
    }
    
    attempt.count++;
    claimAttempts.set(ip, attempt);
    
    if (attempt.count > 10) {
        return res.status(429).json({ error: 'too_many_attempts', message: 'Please wait 10 minutes before trying again.' });
    }

    const { code } = req.body;
    if (!code || code !== PAIRING_CODE) {
        return res.status(403).json({ error: 'invalid_code' });
    }
    // Success - clear attempts
    claimAttempts.delete(ip);
    
    const token = generateToken();
    TOKENS.add(token);
    saveState(); // Save new token
    console.log(`[AUTH] New device paired. Token created.`);
    res.json({ token });
});

// Protected
app.get('/config', requireAuth, (req, res) => {
    res.json({ ok: true, strictMode: STATE.strictMode, ts: new Date().toISOString() });
});

app.post('/config/strict-mode', requireAuth, (req, res) => {
    const { strictMode } = req.body;
    if (typeof strictMode !== 'boolean') {
        return res.status(400).json({ error: 'invalid_input' });
    }
    STATE.strictMode = strictMode;
    saveState();
    console.log(`[CONFIG] Strict Mode set to ${strictMode}`);
    broadcast('config_changed', { strictMode });
    res.json({ ok: true, strictMode });
});

// Migrated to usage of single /status endpoint below
// app.get('/status', requireAuth, ...);

app.get('/approvals', requireAuth, (req, res) => {
    const sorted = [...STATE.approvals].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ approvals: sorted });
});

app.post('/approvals/:id/approve', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { always } = req.body || {};
    const approval = STATE.approvals.find(a => a.id === id);
    if (!approval) return res.status(404).json({ error: 'not_found' });

    if (approval.status !== 'pending') {
        return res.status(409).json({ error: 'already_decided', approval });
    }

    approval.status = 'approved';
    approval.decidedAt = new Date().toISOString();
    
    // Allow Always Logic
    if (always && approval.details && approval.details.cmd) {
        const cmdPattern = "^" + approval.details.cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "$";
        const profileName = STATE.strictMode ? 'balanced' : 'relaxed';
        if (!POLICY.profiles) POLICY.profiles = { balanced: { allow: [] }, relaxed: { allow: [] } };
        if (!POLICY.profiles[profileName]) POLICY.profiles[profileName] = { allow: [] };
        if (!POLICY.profiles[profileName].allow.includes(cmdPattern)) {
            POLICY.profiles[profileName].allow.push(cmdPattern);
            await writeFile(POLICY_FILE, JSON.stringify(POLICY, null, 2));
            console.log(`[POLICY] Added ${cmdPattern} to ${profileName} allowlist`);
        }
    }

    const msg = STATE.messages.find(m => m.approvalId === id);
    if (msg) {
        msg.approvalStatus = 'approved';
        saveState();
    }

    saveApprovals();

    console.log(`[APPROVAL] ${id} APPROVED`);
    broadcast('approval_decided', { id, status: 'approved' });
    if (msg) broadcast('message_update', msg);
    res.json({ ok: true, approval });
});

app.post('/approvals/:id/deny', requireAuth, (req, res) => {
    const { id } = req.params;
    const approval = STATE.approvals.find(a => a.id === id);
    if (!approval) return res.status(404).json({ error: 'not_found' });

    if (approval.status !== 'pending') {
        return res.status(409).json({ error: 'already_decided', approval });
    }

    approval.status = 'denied';
    approval.decidedAt = new Date().toISOString();
    
    const msg = STATE.messages.find(m => m.approvalId === id);
    if (msg) {
        msg.approvalStatus = 'denied';
        saveState();
    }

    saveApprovals();

    console.log(`[APPROVAL] ${id} DENIED`);
    broadcast('approval_decided', { id, status: 'denied' });
    if (msg) broadcast('message_update', msg);
    res.json({ ok: true, approval });
});

app.post('/debug/create-approval', requireAuth, (req, res) => {
    const { kind, details } = req.body;
    const newApproval = {
        id: `appr_${crypto.randomBytes(4).toString('hex')}`,
        createdAt: new Date().toISOString(),
        kind: kind || 'command',
        details: details || { cmd: 'echo "Hello World"', risk: 'low' },
        status: 'pending',
        decidedAt: null
    };

    STATE.approvals.push(newApproval);
    saveApprovals();

    const targetId = STATE.targetProject?.id || STATE.targetProject?.title || (typeof STATE.targetProject === 'string' ? STATE.targetProject : 'global');
    const msgText = kind === 'command' ? `Approval Required: ${details?.cmd}` : `Approval Required: ${kind}`;
    const msg = {
        id: 'msg_appr_' + newApproval.id,
        createdAt: newApproval.createdAt,
        from: 'agent',
        to: 'user',
        channel: 'approval',
        text: msgText,
        status: 'new',
        targetId: targetId,
        approvalId: newApproval.id
    };
    STATE.messages.push(msg);
    if (STATE.messages.length > 200) STATE.messages.shift();
    saveState();

    console.log(`[DEBUG] Created test approval ${newApproval.id}`);
    
    // Write approval request to MemFlow outbox
    memflowWriteResponse(msgText, {
        id: newApproval.id,
        project: targetId,
        channel: 'approval',
        from: 'agent',
        actorId: `agent_${targetId}`
    }).catch(err => console.error('[MEMFLOW] Failed to write debug approval to MemFlow:', err));

    broadcast('approval_requested', newApproval);
    broadcast('message_new', msg);
    res.json(newApproval);
});

// --- New v0.3 Endpoints ---

// POST /messages/send
app.post('/messages/send', checkAuth, async (req, res) => {
    console.log('[DEBUG] HEX DUMP /messages/send body:', JSON.stringify(req.body));
    const { to, channel, text, project, senderAlias } = req.body;
    let { from } = req.body;
    from = from || 'user'; // Default to user if missing

    if (!to || !text) return res.status(400).json({ ok: false, error: 'missing_fields' });
    
    // Auto-align targetProject when user submits a message from the mobile UI
    if (from === 'user' && project) {
        const targets = await getAllTargets();
        const found = targets.find(t => t.id === project || t.title.includes(project) || t.url?.includes(project) || t.projectName === project);
        STATE.targetProject = found || { title: project, projectName: project, connectorId: 'antigravity' };
        saveState();
    }

    // Allow user to forcefully unstick the agent UI state via Quick Actions
    if (text.toUpperCase().includes('ABORT') || text.toUpperCase().includes('STOP')) {
        STATE.agent.state = 'idle';
        STATE.agent.task = 'Execution forcefully aborted.';
        STATE.agent.note = '';
        broadcast('agent_status', STATE.agent);
    }

    let defaultTargetId = 'global';
    if (STATE.targetProject) {
        if (typeof STATE.targetProject === 'string') {
            defaultTargetId = STATE.targetProject;
        } else if (STATE.targetProject.projectName) {
            defaultTargetId = STATE.targetProject.projectName;
        } else if (STATE.targetProject.title) {
            defaultTargetId = STATE.targetProject.title.replace(' - Visual Studio Code', '').split(' — ')[0].trim();
        }
    }
    
    let targetId = project || defaultTargetId;
    
    // Self-healing lane alignment: Inherit the last user message's targetId if agent replies without project context
    if (from === 'agent' && !project) {
        const lastUserMsg = STATE.messages.slice().reverse().find(m => m.from === 'user');
        if (lastUserMsg && lastUserMsg.targetId) {
            targetId = lastUserMsg.targetId;
        }
    }

    const prefix = senderAlias ? `[${senderAlias}] ` : '[Mobile] ';

    const msg = {
        id: 'msg_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        createdAt: new Date().toISOString(),
        from,
        to, // 'agent' or 'user'
        channel: channel || 'general',
        text: (from === 'user' ? prefix : '') + text,
        status: 'new',
        targetId
    };

    STATE.messages.push(msg);
    // Cap history at 200
    if (STATE.messages.length > 200) STATE.messages.shift();
    saveState();

    broadcast('message_new', msg);

    // Trigger Poke if msg is for agent
    if (to === 'agent') {
        schedulePoke();
    } else if (to === 'user' && from === 'agent') {
        // If agent uses the HTTP API instead of MCP tool, we still need to write it to MemFlow!
        memflowWriteResponse(text, {
            id: msg.id.replace(/^msg_(mf_)?/, ''),
            project: targetId,
            channel: channel || 'work',
            from: 'agent',
            actorId: `agent_${targetId}`
        }).catch(err => console.error('[MEMFLOW] Failed to write API response to MemFlow:', err));
    }

    res.json({ ok: true, message: msg });
});

// GET /messages/inbox
app.get('/messages/inbox', checkAuth, (req, res) => {
    const { to, status, limit, filterByProject } = req.query;
    let items = STATE.messages;

    if (to) items = items.filter(m => m.to === to);
    if (status) items = items.filter(m => m.status === status);
    if (filterByProject) {
        items = items.filter(m => {
            if (!m.targetId) return false;
            const fp = String(filterByProject).trim();
            const mt = String(m.targetId).trim();
            // Strict exact match only — no fuzzy endsWith to prevent cross-project leakage
            return mt === fp;
        });
    }

    // Sort newest first
    items = [...items].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (limit) items = items.slice(0, parseInt(limit));

    res.json({ ok: true, messages: items });
});

// POST /messages/:id/ack
app.post('/messages/:id/ack', checkAuth, (req, res) => {
    const { id } = req.params;
    const { status } = req.body; // 'read' or 'done'

    const msg = STATE.messages.find(m => m.id === id);
    if (!msg) return res.status(404).json({ ok: false, error: 'not_found' });

    msg.status = status || 'read';
    saveState();

    broadcast('message_ack', { id, status: msg.status });
    res.json({ ok: true });
});

// POST /agent/heartbeat
app.post('/agent/heartbeat', checkAuth, (req, res) => {
    const { state, task, note } = req.body;

    STATE.agent = {
        ...STATE.agent,
        lastSeen: new Date().toISOString(),
        state: state || STATE.agent.state,
        task: task !== undefined ? task : STATE.agent.task,
        note: note !== undefined ? note : STATE.agent.note
    };
    saveState();

    broadcast('agent_status', STATE.agent);
    res.json({ ok: true, agent: STATE.agent });
});

// GET /agent/status
app.get('/agent/status', checkAuth, (req, res) => {
    res.json({ ok: true, agent: STATE.agent });
});

// GET /projects
app.get('/projects', checkAuth, async (req, res) => {
    try {
        // Assume projects are stored in the parent directory of ag_bridge
        const projectsDir = dirname(__dirname);
        const { readdir, stat } = await import('fs/promises');
        const path = await import('path');
        const items = await readdir(projectsDir, { withFileTypes: true });
        const projects = items
            .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('.'))
            .map(dirent => dirent.name);
            
        // Calculate recent activity
        const projectActivity = {};
        for (const msg of STATE.messages) {
            if (msg.targetId) {
                const tId = msg.targetId.split('/').pop();
                if (!projectActivity[tId] || new Date(msg.createdAt) > new Date(projectActivity[tId])) {
                    projectActivity[tId] = msg.createdAt;
                }
            }
        }
        
        // Fallback to actual file system modification time if no messages exist
        for (const proj of projects) {
            if (!projectActivity[proj]) {
                try {
                    const stats = await stat(path.join(projectsDir, proj));
                    projectActivity[proj] = stats.mtime.toISOString();
                } catch(e) {}
            }
        }

        // Sort projects by recent activity (newest first)
        projects.sort((a, b) => {
            const timeA = projectActivity[a] ? new Date(projectActivity[a]).getTime() : 0;
            const timeB = projectActivity[b] ? new Date(projectActivity[b]).getTime() : 0;
            return timeB - timeA;
        });
            
        // Use Plugin Architecture to scan for Active Windows
        const activeWindows = await getAllTargets();
        
        // Sort active windows by EXISTING activity BEFORE stamping them.
        // Stamping all with the same "now" makes them equal — sort first, stamp second.
        activeWindows.sort((a, b) => {
            const keyA = a.projectName || a.title;
            const keyB = b.projectName || b.title;
            const tA = projectActivity[keyA] ? new Date(projectActivity[keyA]).getTime() : 0;
            const tB = projectActivity[keyB] ? new Date(projectActivity[keyB]).getTime() : 0;
            return tB - tA;
        });
        
        // Now stamp with "now" so the activity dict reflects open windows,
        // but use tiny descending offsets to preserve sort order after stamping.
        const nowMs = Date.now();
        activeWindows.forEach((w, i) => {
            const key = w.projectName || w.title;
            if (key && key !== 'Launchpad') {
                projectActivity[key] = new Date(nowMs - i).toISOString(); // -i ms offset preserves order
            }
        });
        
        // Infer active windows from recent activity (last 24h) or current selection
        const recentProjects = new Set();
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
        
        if (STATE.targetProject) {
            if (typeof STATE.targetProject === 'string') recentProjects.add(STATE.targetProject);
            else if (STATE.targetProject.title) recentProjects.add(STATE.targetProject.title.replace(' - Visual Studio Code', ''));
        }
        
        for (const [proj, timeStr] of Object.entries(projectActivity)) {
            if (new Date(timeStr).getTime() > oneDayAgo) {
                recentProjects.add(proj);
            }
        }
        
        for (const proj of recentProjects) {
            if (proj && proj !== 'global' && proj !== '.memflow') {
                const exists = activeWindows.find(w => w.id === proj || w.title === proj || (w.title && w.title.includes(proj)));
                if (!exists && projects.includes(proj)) {
                    activeWindows.push({
                        id: proj,
                        title: proj,
                        connectorId: 'antigravity',
                        type: 'inferred'
                    });
                }
            }
        }
        
        // Deduplicate activeWindows by projectName (keep the most recently active tab per project)
        const seenProjects = new Map();
        for (const w of activeWindows) {
            const key = w.projectName || w.title;
            if (!seenProjects.has(key)) {
                seenProjects.set(key, w);
            }
        }
        const dedupedWindows = Array.from(seenProjects.values());

        // Sort active windows by recent activity — use projectName as the lookup key
        dedupedWindows.sort((a, b) => {
            const keyA = a.projectName || a.title;
            const keyB = b.projectName || b.title;
            const tA = projectActivity[keyA] ? new Date(projectActivity[keyA]).getTime() : 0;
            const tB = projectActivity[keyB] ? new Date(projectActivity[keyB]).getTime() : 0;
            return tB - tA;
        });
        
        res.json({ ok: true, projects, activeWindows: dedupedWindows, activity: projectActivity, selectedProject: STATE.targetProject });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// POST /projects/select
app.post('/projects/select', checkAuth, async (req, res) => {
    const { project } = req.body;
    if (!project) {
        STATE.targetProject = null;
    } else if (typeof project === 'string') {
        const targets = await getAllTargets();
        const found = targets.find(t => t.id === project || t.title.includes(project) || t.url?.includes(project));
        STATE.targetProject = found || { title: project, connectorId: 'antigravity' };
    } else {
        STATE.targetProject = project;
    }
    saveState();
    res.json({ ok: true, selectedProject: STATE.targetProject });
});

// GET /status (Observability)
app.get('/status', requireAuth, (req, res) => {
    const pending = STATE.approvals.filter(a => a.status === 'pending').length;
    res.json({
        ok: true,
        version: APP_VERSION,
        ts: new Date().toISOString(),
        pendingApprovals: pending,
        totalApprovals: STATE.approvals.length,
        strictMode: STATE.strictMode,
        cdp: {
            enabled: true, // v0.x assumption
            poke_in_flight: pokeInFlight,
            retry_active: !!retryTimer
        },
        agent: {
            state: STATE.agent.state,
            last_seen: STATE.agent.lastSeen
        },
        server: {
            uptime: process.uptime(),
            clients: wss.clients.size
        }
    });
});

// POST /admin/restart
// Exit with code 1 so launchd's KeepAlive restarts us automatically.
// Do NOT use process.exit(0) (clean exit) — launchd won't restart on that.
app.post('/admin/restart', checkAuth, (req, res) => {
    log('RESTART', 'Restart requested from mobile UI.');
    res.json({ ok: true, message: 'Restarting via launchd...' });
    // Give the response time to flush before exiting
    setTimeout(() => {
        process.exit(1); // Non-zero triggers launchd KeepAlive restart
    }, 800);
});

// POST /checkpoint
app.post('/checkpoint', checkAuth, (req, res) => {
    const cp = {
        id: 'cp_' + Date.now(),
        ts: new Date().toISOString(),
        ...req.body
    };

    STATE.checkpoints.push(cp);
    saveState();

    broadcast('checkpoint_new', cp);
    res.json({ ok: true, checkpoint: cp });
});

// --- Legacy v0.2 Routes ---
app.post('/approvals/request', checkAuth, (req, res) => {
    const { kind, details, risk, clientTag } = req.body;

    // Policy Check for commands
    if (kind === 'command') {
        const cmd = details?.cmd;
        const check = checkPolicy(cmd);
        if (!check.allowed) {
            console.warn(`[POLICY] Blocked command: "${cmd}" Reason: ${check.error}`);
            return res.status(403).json({ error: check.error });
        }
    }

    const newApproval = {
        id: `appr_${crypto.randomBytes(4).toString('hex')}`,
        createdAt: new Date().toISOString(),
        kind: kind || 'unknown',
        details: details || {},
        status: 'pending',
        decidedAt: null,
        meta: {
            risk: risk || 'unknown',
            clientTag: clientTag || null
        }
    };

    STATE.approvals.push(newApproval);
    saveApprovals(); // Changed from saveState()

    // Inject message for the chat thread
    const targetId = req.body.project || STATE.targetProject?.id || STATE.targetProject?.title || (typeof STATE.targetProject === 'string' ? STATE.targetProject : 'global');
    const msgText = kind === 'command' ? `Approval Required: ${details?.cmd}` : `Approval Required: ${kind}`;
    
    const msg = {
        id: 'msg_appr_' + newApproval.id,
        createdAt: newApproval.createdAt,
        from: 'agent',
        to: 'user',
        channel: 'approval',
        text: msgText,
        status: 'new',
        targetId: targetId,
        approvalId: newApproval.id
    };
    STATE.messages.push(msg);
    if (STATE.messages.length > 200) STATE.messages.shift();
    saveState();

    console.log(`[REQUEST] Approval requested: ${newApproval.id} (${kind})`);
    
    // Write approval request to MemFlow outbox for reliable mobile delivery
    memflowWriteResponse(msgText, {
        id: newApproval.id,
        project: targetId,
        channel: 'approval',
        from: 'agent',
        actorId: `agent_${targetId}`
    }).catch(err => console.error('[MEMFLOW] Failed to write approval to MemFlow:', err));

    broadcast('approval_requested', newApproval);
    broadcast('message_new', msg);
    res.json({ ok: true, approval: newApproval });
});

app.get('/approvals/:id', checkAuth, (req, res) => {
    const { id } = req.params;
    const approval = STATE.approvals.find(a => a.id === id);
    if (!approval) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, approval });
});

app.get('/approvals/stream/summary', checkAuth, (req, res) => {
    const pending = STATE.approvals.filter(a => a.status === 'pending').length;
    const approved = STATE.approvals.filter(a => a.status === 'approved').length;
    const denied = STATE.approvals.filter(a => a.status === 'denied').length;
    res.json({
        ok: true,
        ts: new Date().toISOString(),
        pending,
        approved,
        denied,
        total: STATE.approvals.length
    });
});

// --- WebSocket Handling ---
server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get('token');
    const pathname = url.pathname;

    if (pathname !== '/events') {
        socket.destroy();
        return;
    }

    // Allow test token in test environment
    if (process.env.NODE_ENV === 'test' && token === 'test-token') {
        // Allow
    } else if (!token || !TOKENS.has(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.send(JSON.stringify({ event: 'hello', payload: { ts: new Date().toISOString() } }));

    // Replay pending approvals
    const pending = STATE.approvals.filter(a => a.status === 'pending');
    for (const approval of pending) {
        ws.send(JSON.stringify({
            event: 'approval_requested',
            payload: approval,
            ts: new Date().toISOString()
        }));
    }
});

// Heartbeat Interval (30s)
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();

        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

// --- MemFlow Outbox Polling ---
// Checks MemFlow for agent responses every 5 seconds and relays them to mobile.
// This completes the round-trip: Mobile → MemFlow inbox → Agent → MemFlow outbox → Mobile
let memflowPollTimer = null;
const MEMFLOW_POLL_INTERVAL = 5000; // 5 seconds

async function pollMemflowOutbox() {
    try {
        // Poll globally across all projects so we catch responses from background windows
        const project = null;
        
        const responses = await memflowPollResponses(project);
        
        if (responses.length > 0) {
            log('MEMFLOW', `Found ${responses.length} agent response(s) in outbox`);
            
            const memflowIdsToMark = [];
            
            // responses from memflow are newest-first (ORDER BY created_at DESC)
            // we must reverse them to process oldest-first to maintain chronological order when pushing
            for (const resp of responses.reverse()) {
                const baseId = resp.id.replace(/^(msg_)?(mf_)?/, '').replace(/^appr_/, '');

                // Convert to ag_bridge message format and store in STATE
                const msg = {
                    id: `msg_mf_${baseId}`,
                    createdAt: resp.createdAt,
                    from: resp.from || 'agent',
                    to: 'user',
                    channel: resp.channel || 'work',
                    text: resp.text,
                    status: 'new',
                    targetId: resp.project || project,
                    source: 'memflow'
                };
                
                // Avoid duplicates by checking exact ID or variations of the same base ID
                const isDuplicate = STATE.messages.find(m => {
                    if (m.id === msg.id) return true;
                    if (m.id === `msg_${baseId}`) return true;
                    if (m.id === `msg_appr_${baseId}`) return true;
                    if (m.id === `msg_mf_${baseId}`) return true;
                    if (m.approvalId === `appr_${baseId}`) return true;
                    return false;
                });

                if (!isDuplicate) {
                    STATE.messages.push(msg);
                    broadcast('message_new', msg);
                    log('MEMFLOW', `Relayed agent response to mobile: ${msg.id}`);
                }
                
                if (resp.memflowId) {
                    memflowIdsToMark.push(resp.memflowId);
                }
            }
            
            // Keep array size manageable
            if (STATE.messages.length > 200) {
                STATE.messages = STATE.messages.slice(-200);
            }
            
            // Mark as read in MemFlow so they don't get polled again
            if (memflowIdsToMark.length > 0) {
                await memflowMarkAsRead(memflowIdsToMark);
            }
            
            saveState();
        }
    } catch (err) {
        // Silent fail — polling errors should not crash the server
        if (err.message && !err.message.includes('no such table')) {
            log('MEMFLOW', `Poll error: ${err.message}`);
        }
    }
}

// Start polling when server starts
memflowPollTimer = setInterval(pollMemflowOutbox, MEMFLOW_POLL_INTERVAL);

// --- Graceful Shutdown ---
function gracefulShutdown(signal) {
    console.log(`\n[SHUTDOWN] Received ${signal}. Closing server...`);
    if (memflowPollTimer) clearInterval(memflowPollTimer);
    server.close(() => {
        console.log('[SHUTDOWN] HTTP server closed.');
        process.exit(0);
    });
    // Force exit after 5s if graceful close hangs
    setTimeout(() => { process.exit(1); }, 5000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    console.error(`[FATAL] Uncaught exception: ${err.message}`);
    console.error(err.stack);
    // Don't exit on non-fatal errors — let launchd restart if truly fatal
    if (err.code === 'EADDRINUSE') process.exit(1);
});

// --- Start ---
// Load state then start
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    Promise.all([loadState(), loadPolicy()]).then(async () => {
        // Dynamic import for ESM compatibility if needed, or standard import
        let qrcode = null;
        try { qrcode = await import('qrcode-terminal'); } catch (e) { console.log('[WARN] qrcode-terminal not found'); }

        function startListening(retryCount = 0) {
            server.on('error', (err) => {
                if (err.code === 'EADDRINUSE' && retryCount < 3) {
                    console.log(`[STARTUP] Port ${PORT} in use (attempt ${retryCount + 1}/3). Killing stale process...`);
                    try {
                        const lsofOut = execSync(`/usr/sbin/lsof -ti :${PORT}`, { encoding: 'utf-8' }).trim();
                        if (lsofOut) {
                            const pids = lsofOut.split('\n').filter(Boolean);
                            const myPid = process.pid.toString();
                            for (const pid of pids) {
                                if (pid !== myPid) {
                                    console.log(`[STARTUP] Killing PID ${pid}`);
                                    execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
                                }
                            }
                        }
                    } catch (killErr) {
                        console.log('[STARTUP] Could not kill stale process:', killErr.message);
                    }
                    // Wait for port to free, then retry bind (no exit/restart needed)
                    console.log(`[STARTUP] Waiting 2s for port to free, then retrying...`);
                    setTimeout(() => {
                        // Create a fresh server to retry
                        server.removeAllListeners('error');
                        startListening(retryCount + 1);
                    }, 2000);
                } else {
                    console.error(`[STARTUP] Fatal server error: ${err.message}`);
                    process.exit(1);
                }
            });

            server.listen(PORT, HOST, () => {
                const ips = getLocalIPs();
                const ts = getTailscaleInfo();

                console.log('='.repeat(50));
                console.log(` AG Bridge v${APP_VERSION} running on port ${PORT}`);
                console.log('='.repeat(50));
                console.log(` PAIRING CODE: [ ${PAIRING_CODE} ]`);
                console.log('-'.repeat(50));

                let qrUrl = null;

                console.log(' Local (same Wi-Fi):');
                if (ips.length > 0) {
                    ips.forEach(ip => {
                        const url = `http://${ip}:${PORT}`;
                        console.log(` ${url}`);
                        if (!qrUrl) qrUrl = url; // Fallback
                    });
                } else {
                    console.log(' (No local LAN IP found)');
                }

                if (ts) {
                    console.log('\n Remote (Tailscale Active):');
                    if (ts.name) {
                        const url = `http://${ts.name}:${PORT}`;
                        console.log(` ${url}`);
                        qrUrl = url; // Priority 1: Tailscale DNS

                        // Auto-provision HTTPS via Tailscale
                        const tsPaths = [
                            '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
                            '/usr/local/bin/tailscale'
                        ];
                        let tsCmd = 'tailscale';
                        try {
                            for (const p of tsPaths) {
                                if (existsSync(p)) { tsCmd = p; break; }
                            }
                        } catch (e) { /* use default */ }
                        try {
                            // Check if serve is already configured before running
                            const serveStatus = execSync(`${tsCmd} serve status 2>&1`, { encoding: 'utf-8' }).trim();
                            const alreadyServing = serveStatus.includes(`:${PORT}`) || serveStatus.includes('proxy');
                            if (!alreadyServing) {
                                execSync(`${tsCmd} serve --bg ${PORT}`, { stdio: 'ignore' });
                                console.log(` https://${ts.name}  (Secure HTTPS — newly provisioned)`);
                            } else {
                                console.log(` https://${ts.name}  (Secure HTTPS Active)`);
                            }
                            qrUrl = `https://${ts.name}`; // Prefer secure for QR
                        } catch (e) {
                            console.log(` [WARN] Tailscale HTTPS not provisioned: ${e.message || 'not enabled on account'}`);
                        }
                    }
                    ts.ips.forEach(ip => {
                        const url = `http://${ip}:${PORT}`;
                        console.log(` ${url}`);
                        if (!qrUrl) qrUrl = url; // Priority 2: Tailscale IP
                    });
                } else {
                    console.log('\n Remote (Tailscale Inactive):');
                    console.log(' Install Tailscale for access anywhere: https://tailscale.com');
                }

                console.log('='.repeat(50));

                // Generate QR Code
                if (qrUrl && qrcode) {
                    const fullUrl = `${qrUrl}?code=${PAIRING_CODE}`;
                    console.log('\nScan to Connect:');
                    qrcode.default.generate(fullUrl, { small: true });
                    console.log(`(Encoded: ${fullUrl})`);
                    console.log('='.repeat(50));
                }
            });
        }

        startListening(0);
    });
}
