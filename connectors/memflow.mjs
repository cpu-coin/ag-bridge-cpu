/**
 * MemFlow Connector for AG Bridge
 * 
 * Replaces the CDP/AppleScript "poke" mechanism with direct MemFlow
 * database writes. When a user sends a message from mobile, this connector
 * writes it into MemFlow's SQLite as a knowledge entry. Any MCP-connected
 * agent (Antigravity, VibeCraft, Maitrix, headless CLI) will pick it up
 * during its normal memory_agent_prepare cycle.
 *
 * No IDE, no CDP port, no Accessibility permissions required.
 */

import { execSync } from 'child_process';
import crypto from 'crypto';

export const CONNECTOR_ID = 'memflow';

// MemFlow CLI path (installed globally)
const MEMFLOW_BIN = process.env.MEMFLOW_BIN || 'memflow';

// Namespace constants for bridge messages
const INBOX_NAMESPACE = 'ag_bridge/inbox';
const OUTBOX_NAMESPACE = 'ag_bridge/outbox';

/**
 * Check if MemFlow is available and reachable.
 * Returns a virtual "target" representing the MemFlow message bus.
 */
export async function getTargets() {
    try {
        const version = execSync(`${MEMFLOW_BIN} --version`, { encoding: 'utf8', timeout: 5000 }).trim();
        return [{
            id: 'memflow-bridge',
            connectorId: CONNECTOR_ID,
            title: `MemFlow (${version})`,
            type: 'memflow',
            webSocketDebuggerUrl: null // Not needed
        }];
    } catch (e) {
        console.warn('[MEMFLOW] MemFlow CLI not found or not running:', e.message);
        return [];
    }
}

/**
 * "Poke" via MemFlow — writes the message into MemFlow's database
 * as a knowledge entry that any connected agent can read.
 * 
 * This completely bypasses CDP and AppleScript.
 */
export async function poke(target, messageContent, metadata = {}) {
    const msgId = `msg_${crypto.randomBytes(6).toString('hex')}`;
    const project = metadata.project || 'global';
    const timestamp = new Date().toISOString();

    const entry = {
        key: `ag_bridge/inbox/${msgId}`,
        content: messageContent,
        coordinates: {
            namespace: INBOX_NAMESPACE,
            scope: 'workspace',
            project: project
        },
        kind: 'knowledge',
        tags: ['mobile', 'pending', 'ag_bridge', project],
        metadata: {
            msgId,
            from: metadata.from || 'user',
            to: metadata.to || 'agent',
            channel: metadata.channel || 'work',
            mobileTimestamp: timestamp,
            status: 'pending',
            project
        },
        provenance: {
            source: 'agent',
            actorId: 'ag_bridge_mobile'
        }
    };

    try {
        // Primary method: Direct SQLite write to MemFlow's database.
        // This is the most reliable path since ag_bridge runs as a standalone
        // Node server, not inside an MCP session.
        const dbPath = process.env.MEMFLOW_SQLITE_PATH || `${process.env.HOME}/.memflow/memflow.sqlite`;
        const result = await writeToDB(dbPath, entry);
        console.log(`[MEMFLOW] Message ${msgId} written to MemFlow inbox for project: ${project}`);
        return result;
    } catch (dbError) {
        console.warn('[MEMFLOW] Direct DB write failed, using drop file fallback...', dbError.message);
        
        // Fallback: Write to a JSON drop file that can be manually imported
        try {
            return await writeDropFile(entry);
        } catch (dropError) {
            console.error('[MEMFLOW] Drop file also failed:', dropError.message);
            return { ok: false, error: 'memflow_store_failed', details: dropError.message };
        }
    }
}

/**
 * Write an entry directly to MemFlow's SQLite database using better-sqlite3.
 * MemFlow uses better-sqlite3 under the hood, so we can import it directly.
 */
async function writeToDB(dbPath, entry) {
    let Database;
    try {
        const mod = await import('better-sqlite3');
        Database = mod.default;
    } catch (e) {
        throw new Error(`better-sqlite3 not available: ${e.message}`);
    }

    const db = new Database(dbPath);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const contentHash = crypto.createHash('sha256').update(entry.content).digest('hex').slice(0, 16);

    try {
        const stmt = db.prepare(`
            INSERT INTO memory_entries (
                id, key, title, content, namespace, project_id, coordinates,
                kind, tags, metadata, source, provenance, confidence,
                embedding, schema_version, embedding_version, content_hash,
                created_at, updated_at, expires_at, last_verified_at, version
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?
            )
        `);

        stmt.run(
            id,
            entry.key,
            entry.key, // title
            entry.content,
            entry.coordinates.namespace,
            entry.coordinates.project || null,
            JSON.stringify(entry.coordinates),
            entry.kind || 'knowledge',
            JSON.stringify(entry.tags || []),
            JSON.stringify(entry.metadata || {}),
            'ag_bridge',
            JSON.stringify(entry.provenance || {}),
            entry.confidence ?? 0.8,
            null, // embedding
            1,    // schema_version
            'none',
            contentHash,
            now,
            now,
            null, // expires_at
            now,  // last_verified_at
            1     // version
        );

        return { ok: true, method: 'memflow_sqlite', id, msgId: entry.metadata.msgId };
    } finally {
        db.close();
    }
}

/**
 * Fallback: Write a JSON drop file for manual import.
 */
async function writeDropFile(entry) {
    const fs = await import('fs/promises');
    const path = await import('path');
    const dropDir = process.env.MEMFLOW_DROP_DIR || `${process.env.HOME}/.memflow/drop`;
    
    await fs.mkdir(dropDir, { recursive: true });
    const dropFile = path.join(dropDir, `ag_bridge_${entry.metadata.msgId}.json`);
    await fs.writeFile(dropFile, JSON.stringify(entry, null, 2));
    
    console.log(`[MEMFLOW] Wrote drop file: ${dropFile}`);
    return { ok: true, method: 'memflow_drop_file', dropFile };
}

/**
 * Poll for agent responses written to MemFlow's outbox namespace.
 * Called by ag_bridge's server.mjs to relay responses back to mobile.
 */
export async function pollResponses(project) {
    try {
        const result = execSync(
            `${MEMFLOW_BIN} search --namespace "${OUTBOX_NAMESPACE}" --tags "unread,${project || 'global'}" --limit 20 --json`,
            { encoding: 'utf8', timeout: 10000 }
        );
        
        const entries = JSON.parse(result);
        return entries.map(e => ({
            id: e.metadata?.msgId || e.id,
            text: e.content,
            from: e.metadata?.from || 'agent',
            channel: e.metadata?.channel || 'work',
            createdAt: e.createdAt || e.updatedAt,
            project: e.metadata?.project || project
        }));
    } catch (e) {
        // Silent fail — no responses yet is normal
        return [];
    }
}
