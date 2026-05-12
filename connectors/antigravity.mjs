import http from 'http';

export const CONNECTOR_ID = 'antigravity';
export const CONNECTOR_NAME = 'Antigravity IDE';
const PORTS = [9000, 9001, 9002, 9003];

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

export async function getTargets() {
    const targets = [];
    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            for (const t of list) {
                if (t.url.includes('workbench') || (t.title && t.title.includes('workbench'))) {
                    targets.push({
                        connectorId: CONNECTOR_ID,
                        id: t.id,
                        title: t.title,
                        port: port,
                        url: t.url,
                        webSocketDebuggerUrl: t.webSocketDebuggerUrl
                    });
                }
            }
        } catch (e) { }
    }
    return targets;
}

const makePokeExpression = (messageContent) => `(async () => {
    // 1. Check for blocking "Cancel" button (Agent is busy)
    const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
    if (cancel && cancel.offsetParent !== null) return { ok:false, reason:"busy_cancel_visible" };

    // Helper: Find editor in a specific root (document or iframe)
    function findInRoot(root) {
        if (!root || !root.querySelectorAll) return null;
        const selector = '#cascade [data-lexical-editor="true"][contenteditable="true"][role="textbox"], ' +
                         'div[contenteditable="true"][role="textbox"], ' +
                         '.monaco-editor textarea';
        const candidates = [...root.querySelectorAll(selector)];
        return candidates.filter(el => el.offsetParent !== null).at(-1);
    }

    function findEditor() {
        let found = findInRoot(document);
        if (found) return found;
        const iframes = document.querySelectorAll('iframe, webview');
        for (const frame of iframes) {
            try {
                const doc = frame.contentDocument;
                if (doc) {
                    found = findInRoot(doc);
                    if (found) return found;
                }
            } catch (e) { }
        }
        return null;
    }

    const editor = findEditor();
    if (!editor) return { ok:false, error:"editor_not_found" };

    const text = ${JSON.stringify(messageContent)};

    editor.focus();
    document.execCommand?.("selectAll", false, null);
    document.execCommand?.("delete", false, null);

    let inserted = false;
    try { inserted = !!document.execCommand?.("insertText", false, text); } catch {}
    if (!inserted) {
        if (editor.tagName === 'TEXTAREA') {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
            nativeInputValueSetter?.call(editor, text);
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            editor.textContent = text;
            editor.dispatchEvent(new InputEvent("beforeinput", { bubbles:true, inputType:"insertText", data:text }));
            editor.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data:text }));
        }
    }

    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const root = editor.getRootNode(); 
    const submit = (root.querySelector || document.querySelector).call(root, "svg.lucide-arrow-right")?.closest("button") || 
                   (root.querySelector || document.querySelector).call(root, '[aria-label="Send Message"]') ||
                   (root.querySelector || document.querySelector).call(root, '.codicon-send');

    if (submit && !submit.disabled) {
        submit.click();
        return { ok:true, method:"click_submit" };
    }

    editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter", code:"Enter", keyCode: 13 }));
    editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles:true, key:"Enter", code:"Enter", keyCode: 13 }));

    return { ok:true, method:"enter_fallback", submitFound: !!submit, submitDisabled: submit?.disabled ?? null };
})()`;

export async function poke(target, messageContent) {
    if (!target || !target.webSocketDebuggerUrl) {
        // Fallback to AppleScript on macOS if CDP is not available
        if (process.platform === 'darwin') {
            try {
                const { execSync } = await import('child_process');
                const safeMsg = messageContent.replace(/"/g, '\\"').replace(/\n/g, '\\n');
                
                // We target the Antigravity Desktop App environments directly
                const appName = 'Electron'; // Defaults to Electron which is running the Antigravity UI
                
                const script = `
                    tell application "${appName}"
                        activate
                        delay 0.1
                        tell application "System Events"
                            keystroke "${safeMsg}"
                            delay 0.1
                            keystroke return
                        end tell
                    end tell
                `;
                execSync(`osascript -e '${script}'`);
                return { ok: true, method: "applescript_fallback" };
            } catch (e) {
                console.warn("[POKE] AppleScript fallback failed (needs Accessibility permissions in System Settings).", e.message);
                return { ok: false, error: "applescript_fallback_failed", details: e.message };
            }
        }
        return { ok: false, error: "cdp_not_found" };
    }

    let WebSocketClass = global.WebSocket;
    if (!WebSocketClass) {
        try {
            const wsModule = await import('ws');
            WebSocketClass = wsModule.default;
        } catch (e) {
            return { ok: false, error: "ws_module_missing", details: e.message };
        }
    }
    const ws = new WebSocketClass(target.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });

    let idCounter = 1;
    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        const handler = (msg) => {
            const data = JSON.parse(msg.data);
            if (data.id === id) {
                ws.removeEventListener('message', handler);
                if (data.error) reject(data.error);
                else resolve(data.result);
            }
        };
        ws.addEventListener('message', handler);
        setTimeout(() => {
            ws.removeEventListener('message', handler);
            reject(new Error("RPC Timeout"));
        }, 3000);
        ws.send(JSON.stringify({ id, method, params }));
    });

    const contexts = [];
    ws.addEventListener('message', (msg) => {
        try {
            const data = JSON.parse(msg.data);
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            }
        } catch { }
    });

    try {
        await call("Runtime.enable", {});
        await new Promise(r => setTimeout(r, 800));

        const expression = makePokeExpression(messageContent);
        for (const ctx of contexts) {
            try {
                const evalPoke = await call("Runtime.evaluate", {
                    expression: expression,
                    returnByValue: true,
                    awaitPromise: true,
                    contextId: ctx.id
                });
                if (evalPoke.result && evalPoke.result.value) {
                    const res = evalPoke.result.value;
                    if (res.ok) return res;
                    if (res.reason === "busy_cancel_visible") return { ok: false, reason: "busy" };
                }
            } catch (ignore) { }
        }
        return { ok: false, error: "editor_not_found_in_any_context" };
    } catch (err) {
        return { ok: false, error: "runtime_error", details: err.message };
    } finally {
        ws.close();
    }
}
