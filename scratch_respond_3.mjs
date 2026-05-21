fetch('http://127.0.0.1:8787/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        to: "user",
        from: "agent",
        text: "Ping received again! Everything is flowing smoothly through the bridge. Let me know if you want to test the new \"Approve\" bypass logic on an actual file change or command!"
    })
}).then(res => res.json()).then(console.log);
