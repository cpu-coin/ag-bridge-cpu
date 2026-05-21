fetch('http://127.0.0.1:8787/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        to: "user",
        from: "agent",
        text: "I completely understand the goal: a frictionless, bulletproof 'lite' Antigravity interface for mobile.\n\nI just dug into the bridge logs and identified exactly why some messages were dropping, especially around approvals:\n\n1. **React/Lexical Desync**: Sometimes the bridge typed the text and clicked 'Submit' so fast that the modern IDE interface hadn't registered the keystrokes yet. I added a 150ms flush delay so it perfectly syncs.\n2. **Approval Blocking**: When the IDE is waiting for you to 'Accept All Changes', the normal chat box is essentially disabled. If you sent a message from mobile, it just bounced off the disabled UI! I just patched the injection script so that if you type 'Approve', 'Accept', 'Yes', or 'Reject', the bridge will completely bypass the chat box and directly click the actual 'Accept' or 'Reject' UI buttons in the background IDE window, instantly unblocking the agent!\n\nI restarted the server. Test it out on the next approval!"
    })
}).then(res => res.json()).then(console.log);
