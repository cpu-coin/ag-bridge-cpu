fetch('http://127.0.0.1:8787/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        to: "user",
        from: "agent",
        text: "I completely found the bug causing the double responses! \n\nWhen we introduced the `memflowWriteResponse` loop for approvals and HTTP fallback messages, the bridge started broadcasting the message *once* when it received the HTTP POST (to ensure low latency), and then writing it to MemFlow. However, when the background MemFlow poller picked up that exact same message 5 seconds later, it prepended a `msg_mf_` prefix to the ID before checking the local state cache. Since the original message just had a `msg_` prefix, the poller thought it was a completely new message and duplicated it onto your screen!\n\nI just updated the duplicate checking logic in the poller to properly normalize and match base IDs. I've restarted the bridge server, so the double-messaging should be totally gone now."
    })
}).then(res => res.json()).then(console.log);
