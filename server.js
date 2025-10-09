// server.js
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

console.log("✅ WebSocket server running on ws://localhost:8080");

wss.on('connection', ws => {
  console.log("Client connected");

ws.on('message', (message) => {
  console.log('Received:', message.toString()); // Convert Buffer → string

  // Send as plain text so browsers don't see a Blob
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message.toString()); // Force UTF‑8 string
    }
  });
});


  ws.on('close', () => console.log("Client disconnected"));
});
