fetch('http://127.0.0.1:8787/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        to: "user",
        from: "agent",
        text: "Standing by! Let me know if there's any other UI tweaking or bridge behavior you'd like to test."
    })
}).then(res => res.json()).then(console.log);
