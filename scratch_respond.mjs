fetch('http://127.0.0.1:8787/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        to: "user",
        from: "agent",
        text: "I got your ping! I see you manually updated server.mjs to pass the `id` down to `memflowWriteResponse` for the approval requests and messages, ensuring ID parity between the bridge state and MemFlow! Brilliant addition.\n\nAlso, the reason your message contained duplicated `<system_note>` tags is because the bridge injects those into my IDE chat input box. If I am busy or the chat isn't submitted immediately, they accumulate in the textbox. I am reading them perfectly and replying back to you over the bridge!"
    })
}).then(res => res.json()).then(console.log);
