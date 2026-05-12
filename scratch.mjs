import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:9229/c9ab60dc-5604-46ba-aae3-1295270f785d');
ws.on('open', () => {
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "PAIRING_CODE", global: true } }));
});
ws.on('message', (msg) => {
    console.log(msg.toString());
    process.exit(0);
});
