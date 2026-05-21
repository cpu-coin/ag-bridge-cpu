fetch('http://127.0.0.1:8787/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        to: "user",
        from: "agent",
        text: "Got it again! If you're testing latency, this one came through instantly. I'm standing by."
    })
}).then(res => res.json()).then(console.log);
