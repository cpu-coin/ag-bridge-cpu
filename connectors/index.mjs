import * as antigravity from './antigravity.mjs';
import * as memflow from './memflow.mjs';

// Registry of all available connectors
// Order matters: memflow is tried first (no IDE dependency),
// antigravity CDP is the fallback for direct IDE injection.
const plugins = [
    memflow,
    antigravity
    // Add maitrix.mjs, vibecraft.mjs here in the future
];

/**
 * Scan all registered plugins to find active targets (windows/agents)
 * @returns {Promise<Array>} Array of target objects
 */
export async function getAllTargets() {
    const allTargets = [];
    for (const plugin of plugins) {
        try {
            if (plugin.getTargets) {
                const targets = await plugin.getTargets();
                allTargets.push(...targets);
            }
        } catch (err) {
            console.error(`[BRIDGE] Plugin ${plugin.CONNECTOR_ID} failed to scan:`, err.message);
        }
    }
    return allTargets;
}

/**
 * Route the poke action to the correct plugin based on the target's connectorId.
 * @param {object} target - The resolved target from getTargets()
 * @param {string} messageContent - The message text to deliver
 * @param {object} metadata - Optional metadata (project, from, channel, etc.)
 */
export async function pokeTarget(target, messageContent, metadata = {}) {
    if (!target) return { ok: false, error: 'no_target_provided' };

    const plugin = plugins.find(p => p.CONNECTOR_ID === target.connectorId);
    if (!plugin) {
        return { ok: false, error: `plugin_not_found: ${target.connectorId}` };
    }

    if (!plugin.poke) {
        return { ok: false, error: `plugin_${plugin.CONNECTOR_ID}_does_not_support_poke` };
    }

    try {
        return await plugin.poke(target, messageContent, metadata);
    } catch (err) {
        return { ok: false, error: 'plugin_execution_error', details: err.message };
    }
}
