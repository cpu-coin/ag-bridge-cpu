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

// MemFlow CLI path (absolute path to ensure background processes find it)
const MEMFLOW_BIN = process.env.MEMFLOW_BIN || '/Users/seanbarger_1/.memflow/bin/memflow';

// Namespace constants for bridge messages
const INBOX_NAMESPACE = 'ag_bridge/inbox';
const OUTBOX_NAMESPACE = 'ag_bridge/outbox';

/**
 * Check if MemFlow is available and reachable.
 * Returns an empty array to prevent the bridge UI from exposing MemFlow
 * as a selectable "execution window" target. MemFlow is strictly used 
 * as a background persistence bus via direct pokeTarget() calls.
 */
export async function getTargets() {
    return [];
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
 * Uses direct SQLite reads to match the write path.
 */
export async function pollResponses(project) {
    const dbPath = process.env.MEMFLOW_SQLITE_PATH || `${process.env.HOME}/.memflow/memflow.sqlite`;
    
    try {
        const mod = await import('better-sqlite3');
        const Database = mod.default;
        const db = new Database(dbPath, { readonly: true });
        
        try {
            const rows = db.prepare(`
                SELECT id, key, content, metadata, created_at
                FROM memory_entries
                WHERE namespace = ?
                  AND tags LIKE '%"unread"%'
                  ${project ? "AND (project_id = ? OR tags LIKE ?)" : ""}
                ORDER BY created_at DESC
                LIMIT 20
            `).all(
                OUTBOX_NAMESPACE,
                ...(project ? [project, `%"${project}"%`] : [])
            );
            
            return rows.map(r => {
                const meta = JSON.parse(r.metadata || '{}');
                return {
                    id: meta.msgId || r.id,
                    memflowId: r.id,
                    text: r.content,
                    from: meta.from || 'agent',
                    channel: meta.channel || 'work',
                    createdAt: r.created_at,
                    project: meta.project || project
                };
            });
        } finally {
            db.close();
        }
    } catch (e) {
        // Silent fail — DB not available or no entries
        return [];
    }
}

/**
 * Read pending messages from the MemFlow inbox (mobile → agent direction).
 * Used by the MCP agent tool to check for mobile messages.
 */
export async function readInbox(project) {
    const dbPath = process.env.MEMFLOW_SQLITE_PATH || `${process.env.HOME}/.memflow/memflow.sqlite`;
    
    try {
        const mod = await import('better-sqlite3');
        const Database = mod.default;
        const db = new Database(dbPath, { readonly: true });
        
        try {
            const rows = db.prepare(`
                SELECT id, key, content, metadata, created_at
                FROM memory_entries
                WHERE namespace = ?
                  AND tags LIKE '%"pending"%'
                  ${project ? "AND (project_id = ? OR tags LIKE ?)" : ""}
                ORDER BY created_at ASC
                LIMIT 50
            `).all(
                INBOX_NAMESPACE,
                ...(project ? [project, `%"${project}"%`] : [])
            );
            
            return rows.map(r => {
                const meta = JSON.parse(r.metadata || '{}');
                return {
                    id: meta.msgId || r.id,
                    memflowId: r.id,
                    text: r.content,
                    from: meta.from || 'user',
                    channel: meta.channel || 'work',
                    createdAt: r.created_at,
                    project: meta.project || project
                };
            });
        } finally {
            db.close();
        }
    } catch (e) {
        return [];
    }
}

/**
 * Mark inbox messages as read (removes "pending" tag, adds "read").
 */
export async function markAsRead(memflowIds) {
    if (!memflowIds || memflowIds.length === 0) return;
    
    const dbPath = process.env.MEMFLOW_SQLITE_PATH || `${process.env.HOME}/.memflow/memflow.sqlite`;
    
    try {
        const mod = await import('better-sqlite3');
        const Database = mod.default;
        const db = new Database(dbPath);
        const now = new Date().toISOString();
        
        try {
            const stmt = db.prepare(`
                UPDATE memory_entries 
                SET tags = REPLACE(REPLACE(tags, '"pending"', '"read"'), '"unread"', '"read"'),
                    metadata = json_set(metadata, '$.status', 'read'),
                    updated_at = ?
                WHERE id = ?
            `);
            
            for (const id of memflowIds) {
                stmt.run(now, id);
            }
        } finally {
            db.close();
        }
    } catch (e) {
        console.warn('[MEMFLOW] Failed to mark messages as read:', e.message);
    }
}

/**
 * Write an agent response to the MemFlow outbox.
 * This is called by the agent (via MCP tool) to send responses back to mobile.
 */
export async function writeResponse(messageContent, metadata = {}) {
    const msgId = metadata.id || `resp_${crypto.randomBytes(6).toString('hex')}`;
    const project = metadata.project || 'global';
    const now = new Date().toISOString();

    const entry = {
        key: `ag_bridge/outbox/${msgId}`,
        content: messageContent,
        coordinates: {
            namespace: OUTBOX_NAMESPACE,
            scope: 'workspace',
            project: project
        },
        kind: 'knowledge',
        tags: ['agent-response', 'unread', 'ag_bridge', project],
        metadata: {
            msgId,
            from: metadata.from || 'agent',
            to: 'user',
            channel: metadata.channel || 'work',
            timestamp: now,
            status: 'unread',
            project,
            inReplyTo: metadata.inReplyTo || null
        },
        provenance: {
            source: 'agent',
            actorId: metadata.actorId || 'ag_bridge_agent'
        }
    };

    const dbPath = process.env.MEMFLOW_SQLITE_PATH || `${process.env.HOME}/.memflow/memflow.sqlite`;
    return writeToDB(dbPath, entry);
}

