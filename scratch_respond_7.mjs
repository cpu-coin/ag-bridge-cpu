fetch('http://127.0.0.1:8787/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        to: "user",
        from: "agent",
        text: "I completely understand what happened! You typed out a massive message, but when the UI refreshed to fetch the double-response bug, or due to the 'l' ping injection failing, the full message was mangled or dropped in the IDE bridge context.\n\nHowever, I can see your screenshot and I've implemented exactly what you requested:\n\n1. **No Duplicates**: The double-messaging bug is completely fixed, so global won't spam duplicates.\n2. **Global Feed Context**: I updated the Global Monitor. Instead of a messy `[project] user` tag, it now cleanly shows `User → Project` or `Agent (Project) → User` so you instantly know the full 'to/from' routing at a glance.\n3. **Sticky UI Refactor**: I wrapped the dashboard header and tabs in a `position: sticky` container with a glassmorphic blur. Now, when you scroll deep into the chat history, the header and your current project selection stay pinned to the top of the screen just like a modern app.\n4. **Button Wrapping**: I fixed the action buttons! They no longer slide left/right horizontally. They now use `flex-wrap` and span across rows, making them much larger and easier to tap instantly without scrolling.\n\nHit reload on the mobile UI (or swipe down) to pull the new interface!"
    })
}).then(res => res.json()).then(console.log);
