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

// Separate queues for different modes
let textWaitingQueue = [];
let videoWaitingQueue = [];

// Map of user IDs to WebSocket connections
let connections = new Map();

// Map of paired users (userId -> partnerId)
let pairs = new Map();

// Map of user IDs to their chat mode
let userModes = new Map();

wss.on("connection", (ws) => {
  console.log("New WebSocket connection");

  ws.on("message", (message) => {
    const data = JSON.parse(message.toString());
    console.log("Received:", data);

    switch (data.type) {
      case "join-text":
        handleTextJoin(ws, data.userId);
        break;
      case "join-video":
        handleVideoJoin(ws, data.userId);
        break;
      case "text-message":
        handleTextMessage(data);
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

function handleTextJoin(ws, userId) {
  console.log(`User ${userId} joining text chat`);
  connections.set(userId, ws);
  userModes.set(userId, "text");

  if (textWaitingQueue.length > 0) {
    // Pair with waiting user
    const partnerId = textWaitingQueue.shift();
    pairs.set(userId, partnerId);
    pairs.set(partnerId, userId);

    // Notify both users
    const partnerWs = connections.get(partnerId);
    ws.send(JSON.stringify({ type: "paired", partnerId }));
    partnerWs.send(JSON.stringify({ type: "paired", partnerId: userId }));

    console.log(`Paired text chat users: ${userId} and ${partnerId}`);
  } else {
    // Add to queue
    textWaitingQueue.push(userId);
    ws.send(JSON.stringify({ type: "waiting" }));
    console.log(`User ${userId} added to text chat queue`);
  }
}

function handleVideoJoin(ws, userId) {
  console.log(`User ${userId} joining video chat`);
  connections.set(userId, ws);
  userModes.set(userId, "video");

  if (videoWaitingQueue.length > 0) {
    // Pair with waiting user - the waiting user is the offerer
    const partnerId = videoWaitingQueue.shift();
    pairs.set(userId, partnerId);
    pairs.set(partnerId, userId);

    // Notify both users
    const partnerWs = connections.get(partnerId);
    ws.send(JSON.stringify({ type: "paired", partnerId, isOfferer: false }));
    partnerWs.send(
      JSON.stringify({ type: "paired", partnerId: userId, isOfferer: true })
    );

    console.log(`Paired video chat users: ${userId} and ${partnerId}`);
  } else {
    // Add to queue
    videoWaitingQueue.push(userId);
    ws.send(JSON.stringify({ type: "waiting" }));
    console.log(`User ${userId} added to video chat queue`);
  }
}

function handleTextMessage(data) {
  const { userId, targetId, message } = data;
  console.log(`Text message from ${userId} to ${targetId}: ${message}`);

  const targetWs = connections.get(targetId);
  if (targetWs) {
    targetWs.send(
      JSON.stringify({
        type: "text-message",
        from: userId,
        message,
      })
    );
  } else {
    console.warn(`Target user ${targetId} not found`);
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
  console.log(`User ${userId} disconnecting`);

  const userMode = userModes.get(userId);

  connections.delete(userId);
  userModes.delete(userId);

  // Remove from appropriate queue if waiting
  if (userMode === "text") {
    const index = textWaitingQueue.indexOf(userId);
    if (index !== -1) {
      textWaitingQueue.splice(index, 1);
      console.log(`Removed ${userId} from text chat queue`);
    }
  } else if (userMode === "video") {
    const index = videoWaitingQueue.indexOf(userId);
    if (index !== -1) {
      videoWaitingQueue.splice(index, 1);
      console.log(`Removed ${userId} from video chat queue`);
    }
  }

  // Handle pairing
  const partnerId = pairs.get(userId);
  if (partnerId) {
    pairs.delete(userId);
    pairs.delete(partnerId);

    const partnerWs = connections.get(partnerId);
    const partnerMode = userModes.get(partnerId);

    if (partnerWs) {
      partnerWs.send(JSON.stringify({ type: "partner-disconnected" }));

      // Put partner back in appropriate queue
      if (partnerMode === "text") {
        textWaitingQueue.push(partnerId);
        partnerWs.send(JSON.stringify({ type: "waiting" }));
        console.log(`Put ${partnerId} back in text chat queue`);
      } else if (partnerMode === "video") {
        videoWaitingQueue.push(partnerId);
        partnerWs.send(JSON.stringify({ type: "waiting" }));
        console.log(`Put ${partnerId} back in video chat queue`);
      }
    }
  }

  console.log(`User ${userId} disconnected and cleaned up`);
}
