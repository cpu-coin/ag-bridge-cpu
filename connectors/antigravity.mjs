import http from 'http';

export const CONNECTOR_ID = 'antigravity';
export const CONNECTOR_NAME = 'Antigravity IDE';
const STATIC_PORTS = [9000, 9001, 9002, 9003];

// Dynamically discover Antigravity's CDP port (the upgrade uses --remote-debugging-port=0)
async function discoverPorts() {
    const ports = new Set(STATIC_PORTS);
    try {
        const { execSync } = await import('child_process');
        const out = execSync("lsof -i -nP 2>/dev/null | grep -i 'Antigravi' | grep 'LISTEN'", { encoding: 'utf8', timeout: 3000 });
        const matches = out.matchAll(/:(\d+)\s+\(LISTEN\)/g);
        for (const m of matches) {
            ports.add(parseInt(m[1], 10));
        }
    } catch (e) { /* lsof not available or no results */ }
    return [...ports];
}

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

export function extractProjectName(title) {
    if (!title) return '';
    let p = title;
    if (p.includes(' — ')) {
        p = p.split(' — ')[0].trim();
    } else if (p.includes(' - ')) {
        const parts = p.split(' - ');
        p = parts.length > 1 ? parts[parts.length - 2].trim() : parts[0].trim();
    }
    return p.replace(' (Workspace)', '').trim();
}

export async function getTargets() {
    const targets = [];
    const ports = await discoverPorts();
    for (const port of ports) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            for (const t of list) {
                // Skip chrome extensions, service workers, diff workers, and blank pages
                const url = t.url || '';
                const title = t.title || '';
                if (url.includes('chrome-extension://') ||
                    url.includes('chrome://') ||
                    url.includes('diff_worker') ||
                    url.includes('stripe.com') ||
                    url.includes('stripe.network') ||
                    url.includes('accounts.google.com') ||
                    (!title && !url)) continue;

                // Accept workbench targets (legacy) AND conversation targets (v2.0 upgrade)
                const isWorkbench = url.includes('workbench');
                const isConversation = url.includes('/c/');
                const isLocalPage = url.startsWith('file://') || url.startsWith('http://localhost') || url.startsWith('https://127.0.0.1');

                if (isWorkbench || isConversation || isLocalPage) {
                    targets.push({
                        connectorId: CONNECTOR_ID,
                        id: t.id,
                        title: title,
                        projectName: extractProjectName(title),
                        port: port,
                        url: url,
                        webSocketDebuggerUrl: t.webSocketDebuggerUrl
                    });
                }
            }
        } catch (e) { }
    }
    return targets;
}

const makePokeExpression = (messageContent) => `(async () => {
    const text = ${JSON.stringify(messageContent)};

    // Attempt to open chat panel via Cmd+L
    document.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true, key: 'l', code: 'KeyL', keyCode: 76, bubbles: true }));
    await new Promise(r => setTimeout(r, 800)); // Increased to 800ms to allow lazy-loading of the chat panel DOM

    // 1. Check for blocking "Cancel" button (Agent is busy)
    const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
    if (cancel && cancel.offsetParent !== null) {
        if (text.toUpperCase().includes('ABORT') || text.toUpperCase().includes('STOP')) {
            cancel.click();
            return { ok: true, method: "click_cancel" };
        }
        return { ok:false, reason:"busy_cancel_visible" };
    }

    // Helper: Find editor in a specific root (document or iframe)
    function findInRoot(root) {
        if (!root || !root.querySelectorAll) return null;
        const selector = '#cascade [data-lexical-editor="true"][contenteditable="true"][role="textbox"], ' +
                         'div[contenteditable="true"][role="textbox"], ' +
                         '.monaco-editor textarea, ' +
                         'textarea[aria-label*="Ask"], textarea[aria-label*="Chat"], ' +
                         'div.interactive-input-part textarea, ' +
                         'textarea[placeholder*="Ask"], textarea[placeholder*="Message"]';
        const candidates = [...root.querySelectorAll(selector)];
        const visible = candidates.filter(el => el.offsetParent !== null || el.getBoundingClientRect().width > 0);
        return visible.length > 0 ? visible.at(-1) : candidates.at(-1);
    }

    async function findEditorAsync() {
        for (let i = 0; i < 5; i++) {
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
            if (i < 4) await new Promise(r => setTimeout(r, 300));
        }
        return null;
    }

    const editor = await findEditorAsync();
    if (!editor) return { ok:false, error:"editor_not_found" };

    // text definition moved up

    const lowerText = text.toLowerCase().trim();
    const root = editor.getRootNode();
    const buttons = Array.from((root.querySelectorAll || document.querySelectorAll).call(root, 'button'));
    
    // Check for Approval buttons (Accept/Reject)
    const approveBtn = buttons.find(b => b.textContent && (b.textContent.toLowerCase().includes('approve') || b.textContent.toLowerCase().includes('accept')));
    const rejectBtn = buttons.find(b => b.textContent && (b.textContent.toLowerCase().includes('reject') || b.textContent.toLowerCase().includes('deny')));

    if (approveBtn && (lowerText === 'yes' || lowerText === 'y' || lowerText === 'approve' || lowerText === 'accept' || lowerText.includes('accept all'))) {
        approveBtn.click();
        return { ok: true, method: "click_approve" };
    }
    
    if (rejectBtn && (lowerText === 'no' || lowerText === 'n' || lowerText === 'reject' || lowerText === 'deny')) {
        rejectBtn.click();
        return { ok: true, method: "click_reject" };
    }

    editor.focus();
    document.execCommand?.("selectAll", false, null);
    document.execCommand?.("delete", false, null);

    let inserted = false;
    try { inserted = !!document.execCommand?.("insertText", false, text); } catch {}
    if (!inserted) {
        if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set || 
                                           Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            if (nativeInputValueSetter) {
                nativeInputValueSetter.call(editor, text);
            } else {
                editor.value = text;
            }
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            // For Lexical and contenteditables, textContent breaks the internal state.
            // Dispatching a paste event is universally supported by rich text editors.
            const dataTransfer = new DataTransfer();
            dataTransfer.setData('text/plain', text);
            const pasteEvent = new ClipboardEvent('paste', {
                clipboardData: dataTransfer,
                bubbles: true,
                cancelable: true
            });
            editor.dispatchEvent(pasteEvent);
            
            // If it still didn't update (extremely rare), fallback to textContent
            if (!editor.textContent.includes(text.substring(0, 5))) {
                editor.textContent = text;
                editor.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data:text }));
            }
        }
    }

    // Wait for React/Lexical state to flush the new text
    await new Promise(r => setTimeout(r, 150));

    const submit = (root.querySelector || document.querySelector).call(root, "svg.lucide-arrow-right")?.closest("button") || 
                   (root.querySelector || document.querySelector).call(root, '[aria-label="Send Message"]') ||
                   (root.querySelector || document.querySelector).call(root, '.codicon-send') ||
                   buttons.find(b => b.textContent?.toLowerCase() === 'send');

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
                const appName = 'Antigravity'; 
                const projTarget = target.title || target.id || '';
                
                let fallbackTarget = projTarget;
                if (projTarget.includes(' — ')) {
                    fallbackTarget = projTarget.split(' — ')[0].trim();
                } else if (projTarget.includes(' - ')) {
                    const parts = projTarget.split(' - ');
                    fallbackTarget = parts.length > 1 ? parts[parts.length - 2].trim() : parts[0].trim();
                }

                let script = `
                    tell application "System Events"
                        tell process "${appName}"
                            set frontmost to true
                            delay 0.1
                            keystroke "${safeMsg}"
                            delay 0.1
                            keystroke return
                        end tell
                    end tell
                `;

                if (projTarget && projTarget !== 'global') {
                    // Try to raise the specific project window. If it fails, do not keystroke into the wrong one!
                    script = `
                        tell application "System Events"
                            tell process "${appName}"
                                set foundWindow to false
                                try
                                    click (first menu item of menu 1 of menu bar item "Window" of menu bar 1 whose name contains "${projTarget}")
                                    set frontmost to true
                                    set foundWindow to true
                                    delay 0.1
                                on error
                                    try
                                        click (first menu item of menu 1 of menu bar item "Window" of menu bar 1 whose name contains "${fallbackTarget}")
                                        set frontmost to true
                                        set foundWindow to true
                                        delay 0.1
                                    on error
                                        set foundWindow to false
                                    end try
                                end try
                                
                                if foundWindow then
                                    keystroke "${safeMsg}"
                                    delay 0.1
                                    keystroke return
                                else
                                    error "Target window not found"
                                end if
                            end tell
                        end tell
                    `;
                }
                
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

    try {
        await call("Runtime.enable", {});
        await call("Page.enable", {}).catch(() => {}); // may not be available on all targets

        // Send Cmd+L (Meta+L) to open the chat panel
        try {
            await call("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 8, windowsVirtualKeyCode: 76, key: "l" });
            await call("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 8, windowsVirtualKeyCode: 76, key: "l" });
            await new Promise(r => setTimeout(r, 200)); // wait for UI
        } catch (e) { /* ignore if Input domain unsupported */ }

        const expression = makePokeExpression(messageContent);

        // Strategy 1: Evaluate in the default (main) execution context directly.
        // This works when the page is already loaded — no need to wait for context events.
        try {
            const evalResult = await call("Runtime.evaluate", {
                expression,
                returnByValue: true,
                awaitPromise: true,
            });
            const val = evalResult?.result?.value;
            if (val?.ok) return val;
            if (val?.reason === "busy_cancel_visible") return { ok: false, reason: "busy" };
            // If editor not found in main context, fall through to frame search
        } catch (e) { /* try frames next */ }

        // Strategy 2: Enumerate all frames and evaluate in each execution context.
        // Covers Electron webviews and sandboxed iframes.
        try {
            const { frameTree } = await call("Page.getFrameTree", {});
            const frameIds = [];
            const collectFrames = (node) => {
                if (node?.frame?.id) frameIds.push(node.frame.id);
                for (const child of node?.childFrames || []) collectFrames(child);
            };
            collectFrames(frameTree);

            // Get all execution contexts for those frames
            const { contexts: allContexts } = await call("Runtime.getHeapUsage", {}).catch(() => ({ contexts: [] }));

            // Fallback: use frameId-based context execution
            for (const frameId of frameIds) {
                try {
                    const evalResult = await call("Runtime.evaluate", {
                        expression,
                        returnByValue: true,
                        awaitPromise: true,
                    });
                    const val = evalResult?.result?.value;
                    if (val?.ok) return val;
                } catch (e) { }
            }
        } catch (e) { /* Page.getFrameTree not supported */ }

        return { ok: false, error: "editor_not_found_in_any_context" };
    } catch (err) {
        return { ok: false, error: "runtime_error", details: err.message };
    } finally {
        ws.close();
    }
}
