fetch('http://127.0.0.1:8787/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        to: "user",
        from: "agent",
        text: "Great questions. Here are the updates and answers:\n\n1. **Copy Buttons**: I just added interactive Copy buttons to the top right of every single message in both the Global feed and the individual Chat feeds. They use a sleek SVG that turns green when tapped.\n2. **Database Options**: Yes! MemFlow inherently supports MongoDB, SQLite, and in-memory options purely via connection strings. The bridge utilizes standard MemFlow connector APIs, so whatever DB backend MemFlow is configured for (MongoDB for production) is what the bridge inherently uses.\n3. **Repository Sync**: Just to clarify—none of the edits today have touched the core `memflow` codebase! All of today's stability fixes have been strictly inside `ag_bridge`. MemFlow itself remains untouched and ready for community/private release.\n4. **Approvals / Accept Buttons**: Here is why the actual Approval UI Card doesn't pop up: When the desktop IDE (like Roo) catches a sensitive command, it *pauses the agent's execution entirely*. Because the agent is paused, it cannot make the HTTP request to the bridge to trigger the Approval Card! To solve this, **I just added 👍 Approve and 👎 Reject buttons to the Quick Actions bar** right above your chat input. If the agent says 'I need to run this command', just tap the 'Approve' Quick Action. The bridge will instantly bypass the chat, reach into the IDE DOM, and click the real Accept button for you!\n\nRefresh the UI to see the Copy and Approve buttons!"
    })
}).then(res => res.json()).then(console.log);
