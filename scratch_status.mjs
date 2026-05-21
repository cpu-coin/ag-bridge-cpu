fetch('http://127.0.0.1:8787/agent/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: "working", task: "Acknowledging STATUS command" })
});
fetch('http://127.0.0.1:8787/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        to: "user",
        from: "agent",
        text: "STATUS ACKNOWLEDGED: The bridge is online and fully responsive! I received your STATUS ping and your 'm l' test. I also just sent a state update to the mobile UI to demonstrate the /agent/status endpoint functionality!"
    })
}).then(res => res.json()).then(console.log);
