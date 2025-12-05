const express = require("express");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, "public")));

// Start HTTP server
const server = app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

// WebSocket server
const wss = new WebSocket.Server({ server });

// In-memory queue for waiting users
let waitingQueue = [];

// Map of user IDs to WebSocket connections
let connections = new Map();

// Map of paired users (userId -> partnerId)
let pairs = new Map();

wss.on("connection", (ws) => {
  console.log("New WebSocket connection");

  ws.on("message", (message) => {
    const data = JSON.parse(message.toString());
    console.log("Received:", data);

    switch (data.type) {
      case "join":
        handleJoin(ws, data.userId);
        break;
      case "offer":
      case "answer":
      case "ice-candidate":
        handleSignaling(data);
        break;
      case "disconnect":
        handleDisconnect(data.userId);
        break;
    }
  });

  ws.on("close", () => {
    // Find and remove the user from connections
    for (let [userId, conn] of connections) {
      if (conn === ws) {
        handleDisconnect(userId);
        break;
      }
    }
  });
});

function handleJoin(ws, userId) {
  connections.set(userId, ws);

  if (waitingQueue.length > 0) {
    // Pair with waiting user
    const partnerId = waitingQueue.shift();
    pairs.set(userId, partnerId);
    pairs.set(partnerId, userId);

    // Notify both users - the waiting user is the offerer
    const partnerWs = connections.get(partnerId);
    ws.send(JSON.stringify({ type: "paired", partnerId, isOfferer: false }));
    partnerWs.send(
      JSON.stringify({ type: "paired", partnerId: userId, isOfferer: true })
    );
  } else {
    // Add to queue
    waitingQueue.push(userId);
    ws.send(JSON.stringify({ type: "waiting" }));
  }
}

function handleSignaling(data) {
  const { userId, targetId, ...signalData } = data;
  const targetWs = connections.get(targetId);
  if (targetWs) {
    targetWs.send(
      JSON.stringify({ type: data.type, from: userId, ...signalData })
    );
  }
}

function handleDisconnect(userId) {
  connections.delete(userId);

  // Remove from queue if waiting
  const index = waitingQueue.indexOf(userId);
  if (index !== -1) {
    waitingQueue.splice(index, 1);
  }

  // Handle pairing
  const partnerId = pairs.get(userId);
  if (partnerId) {
    pairs.delete(userId);
    pairs.delete(partnerId);

    const partnerWs = connections.get(partnerId);
    if (partnerWs) {
      partnerWs.send(JSON.stringify({ type: "partner-disconnected" }));
      // Put partner back in queue
      waitingQueue.push(partnerId);
      partnerWs.send(JSON.stringify({ type: "waiting" }));
    }
  }
}
