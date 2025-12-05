const express = require("express");
const WebSocket = require("ws");
const path = require("path");

// Security packages
const winston = require("winston");

const app = express();
const port = process.env.PORT || 3000;

// Initialize profanity filter (custom implementation to avoid ES module issues)
const badWordsList = ['damn', 'hell', 'crap', 'fuck', 'shit', 'bitch', 'ass', 'bastard'];
const profanityFilter = {
  isProfane: (text) => {
    const lowerText = text.toLowerCase();
    return badWordsList.some(word => new RegExp(`\\b${word}\\b`, 'i').test(lowerText));
  },
  clean: (text) => {
    let cleaned = text;
    badWordsList.forEach(word => {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      cleaned = cleaned.replace(regex, '*'.repeat(word.length));
    });
    return cleaned;
  }
};

// Configure logging
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, "public")));

// Start HTTP server
const server = app.listen(port, () => {
  logger.info(`Server running on http://localhost:${port}`);
});

// WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// Separate queues for different modes
let textWaitingQueue = [];
let videoWaitingQueue = [];

// Map of user IDs to WebSocket connections
let connections = new Map();

// Map of paired users (userId -> partnerId)
let pairs = new Map();

// Map of user IDs to their chat mode
let userModes = new Map();

// Track total users
// Track total users - Now using wss.clients.size
// let totalUsers = 0; // Removed manual tracking

// Store reports
let reports = [];

// Security: Rate limiting
const rateLimits = new Map(); // userId -> { messages: [], skips: [], reports: [] }

// Security: IP tracking and banning
const ipConnections = new Map(); // IP -> { connections: [], lastConnection: timestamp }
const bannedIPs = new Map(); // IP -> { until: timestamp, reason: string }
const userIPs = new Map(); // userId -> IP

// Security: Session fingerprinting
const fingerprints = new Map(); // fingerprint -> { userIds: Set, reports: 0, bans: 0, firstSeen: timestamp }

// Security: Abuse tracking
const abuseTracking = new Map(); // userId -> { messageCount, skipCount, reportCount, violations: [] }

// ===== Security Helper Functions =====

// Get real client IP (supports proxies)
function getClientIP(request) {
  return (
    request.headers["x-forwarded-for"]?.split(",")[0] ||
    request.headers["x-real-ip"] ||
    request.socket.remoteAddress ||
    request.connection.remoteAddress
  );
}

// Check if IP is banned
function isIPBanned(ip) {
  const ban = bannedIPs.get(ip);
  if (!ban) return false;

  if (Date.now() > ban.until) {
    bannedIPs.delete(ip);
    logger.info(`Ban expired for IP: ${ip}`);
    return false;
  }
  return true;
}

// Ban an IP address
function banIP(ip, durationMs, reason) {
  bannedIPs.set(ip, {
    until: Date.now() + durationMs,
    reason
  });
  logger.warn(`Banned IP ${ip} for ${durationMs}ms: ${reason}`);
}

// Check rate limit
function checkRateLimit(userId, action, maxPerMinute) {
  const now = Date.now();

  if (!rateLimits.has(userId)) {
    rateLimits.set(userId, { messages: [], skips: [], reports: [] });
  }

  const userLimits = rateLimits.get(userId);
  const actionArray = userLimits[action] || [];

  // Remove entries older than 1 minute
  const recentActions = actionArray.filter(time => now - time < 60000);
  userLimits[action] = recentActions;

  if (recentActions.length >= maxPerMinute) {
    logger.warn(`Rate limit exceeded for user ${userId}, action: ${action}`);
    return false;
  }

  recentActions.push(now);
  return true;
}

// Validate message content
function validateMessage(message) {
  if (typeof message !== "string") return { valid: false, reason: "Invalid type" };
  if (message.length === 0) return { valid: false, reason: "Empty message" };
  if (message.length > 500) return { valid: false, reason: "Message too long" };

  // Block dangerous patterns
  const dangerousPatterns = [
    /<script/i,
    /javascript:/i,
    /on\w+=/i,
    /<iframe/i,
    /eval\(/i,
    /<object/i,
    /<embed/i
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(message)) {
      return { valid: false, reason: "Dangerous content detected" };
    }
  }

  return { valid: true };
}

// Filter profanity
function filterProfanity(message) {
  try {
    if (profanityFilter.isProfane(message)) {
      logger.info(`Profanity detected in message: ${message.substring(0, 20)}...`);
      return profanityFilter.clean(message);
    }
    return message;
  } catch (e) {
    logger.error(`Error filtering profanity: ${e.message}`);
    return message;
  }
}

// Track user fingerprint
function trackFingerprint(fingerprint, userId) {
  if (!fingerprints.has(fingerprint)) {
    fingerprints.set(fingerprint, {
      userIds: new Set(),
      reports: 0,
      bans: 0,
      firstSeen: Date.now()
    });
  }

  const session = fingerprints.get(fingerprint);
  session.userIds.add(userId);

  // Check if fingerprint has too many reports/bans
  if (session.reports >= 5 || session.bans >= 3) {
    logger.warn(`Suspicious fingerprint detected: ${fingerprint}`);
    return { suspicious: true, reason: "Multiple violations" };
  }

  return { suspicious: false };
}

// Detect abuse patterns
function detectAbusePatterns(userId) {
  if (!abuseTracking.has(userId)) {
    abuseTracking.set(userId, {
      messageCount: 0,
      skipCount: 0,
      reportCount: 0,
      violations: [],
      startTime: Date.now()
    });
  }

  const tracking = abuseTracking.get(userId);
  const sessionDuration = (Date.now() - tracking.startTime) / 1000; // seconds
  const patterns = [];

  // Detect spammer (high message rate)
  if (sessionDuration > 10 && tracking.messageCount / sessionDuration > 2) {
    patterns.push("spammer");
  }

  // Detect skip abuser
  if (tracking.skipCount > 15) {
    patterns.push("skip_abuser");
  }

  // Detect harasser (reported multiple times)
  if (tracking.reportCount >= 3) {
    patterns.push("harasser");
  }

  return patterns;
}

// Handle abuse detection
function handleAbuseDetection(userId, ip, patterns) {
  if (patterns.length === 0) return;

  logger.warn(`Abuse patterns detected for user ${userId}: ${patterns.join(", ")}`);

  if (patterns.includes("harasser")) {
    banIP(ip, 24 * 60 * 60 * 1000, "Multiple reports");
    handleDisconnect(userId);
  } else if (patterns.includes("spammer")) {
    banIP(ip, 60 * 60 * 1000, "Spamming");
    handleDisconnect(userId);
  } else if (patterns.includes("skip_abuser")) {
    // Warn user
    const ws = connections.get(userId);
    if (ws) {
      ws.send(JSON.stringify({
        type: "warning",
        message: "Excessive skipping detected. Please use the app responsibly."
      }));
    }
  }
}

// WebSocket upgrade handler with IP check
server.on("upgrade", (request, socket, head) => {
  const ip = getClientIP(request);

  // Check if IP is banned
  if (isIPBanned(ip)) {
    logger.warn(`Rejected connection from banned IP: ${ip}`);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  // Check connection rate limit (max 5 connections per minute per IP)
  const now = Date.now();
  if (!ipConnections.has(ip)) {
    ipConnections.set(ip, { connections: [], lastConnection: now });
  }

  const ipData = ipConnections.get(ip);
  ipData.connections = ipData.connections.filter(time => now - time < 60000);

  if (ipData.connections.length >= 5) {
    logger.warn(`Connection rate limit exceeded for IP: ${ip}`);
    socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    socket.destroy();
    return;
  }

  ipData.connections.push(now);
  ipData.lastConnection = now;

  // Continue with WebSocket upgrade
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.ip = ip;
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws) => {
  logger.info(`New WebSocket connection from IP: ${ws.ip}`);
  // totalUsers++; // Removed manual tracking
  broadcastUserCount();

  ws.on("message", (message) => {
    // Security: Check message size (max 10KB)
    if (message.length > 10240) {
      logger.warn(`Oversized message from IP ${ws.ip}: ${message.length} bytes`);
      ws.send(JSON.stringify({
        type: "error",
        message: "Message too large"
      }));
      return;
    }

    // Parse message
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (e) {
      logger.error(`Invalid JSON from IP ${ws.ip}: ${e.message}`);
      ws.close(1003, "Invalid message format");
      return;
    }

    logger.info(`Received from ${data.userId}: ${data.type}`);

    switch (data.type) {
      case "identify":
        handleIdentify(ws, data);
        break;
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
      case "typing-start":
      case "typing-stop":
        handleTyping(data);
        break;
      case "report-user":
        handleReport(data);
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
    // totalUsers--; // Removed manual tracking
    broadcastUserCount();
    logger.info(`WebSocket connection closed from IP: ${ws.ip}`);
  });
});

function handleTextJoin(ws, userId) {
  logger.info(`User ${userId} joining text chat`);
  connections.set(userId, ws);
  userModes.set(userId, "text");

  // Track user IP
  userIPs.set(userId, ws.ip);

  if (textWaitingQueue.length > 0) {
    // Pair with waiting user
    const partnerId = textWaitingQueue.shift();
    pairs.set(userId, partnerId);
    pairs.set(partnerId, userId);

    // Notify both users
    const partnerWs = connections.get(partnerId);
    ws.send(JSON.stringify({ type: "paired", partnerId }));
    partnerWs.send(JSON.stringify({ type: "paired", partnerId: userId }));

    logger.info(`Paired text chat users: ${userId} and ${partnerId}`);
  } else {
    // Add to queue
    textWaitingQueue.push(userId);
    ws.send(JSON.stringify({ type: "waiting" }));
    logger.info(`User ${userId} added to text chat queue`);
  }
}

function handleVideoJoin(ws, userId) {
  logger.info(`User ${userId} joining video chat`);
  connections.set(userId, ws);
  userModes.set(userId, "video");

  // Track user IP
  userIPs.set(userId, ws.ip);

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

    logger.info(`Paired video chat users: ${userId} and ${partnerId}`);
  } else {
    // Add to queue
    videoWaitingQueue.push(userId);
    ws.send(JSON.stringify({ type: "waiting" }));
    logger.info(`User ${userId} added to video chat queue`);
  }
}

function handleIdentify(ws, data) {
  const { userId, fingerprint } = data;

  if (!fingerprint) return;

  logger.info(`User ${userId} identified with fingerprint: ${fingerprint}`);

  // Track fingerprint
  const fingerprintCheck = trackFingerprint(fingerprint, userId);

  if (fingerprintCheck.suspicious) {
    logger.warn(`Suspicious user ${userId}: ${fingerprintCheck.reason}`);
    ws.send(JSON.stringify({
      type: "warning",
      message: "Your account has been flagged. Please use the app responsibly."
    }));
  }
}

function handleTextMessage(data) {
  const { userId, targetId, message } = data;

  // Security: Check rate limit (30 messages per minute)
  if (!checkRateLimit(userId, "messages", 30)) {
    const ws = connections.get(userId);
    if (ws) {
      ws.send(JSON.stringify({
        type: "error",
        message: "Slow down! You're sending messages too quickly."
      }));
    }
    return;
  }

  // Security: Validate message
  const validation = validateMessage(message);
  if (!validation.valid) {
    logger.warn(`Invalid message from ${userId}: ${validation.reason}`);
    const ws = connections.get(userId);
    if (ws) {
      ws.send(JSON.stringify({
        type: "error",
        message: `Message rejected: ${validation.reason}`
      }));
    }
    return;
  }

  // Security: Filter profanity
  const filteredMessage = filterProfanity(message);

  // Track abuse
  if (!abuseTracking.has(userId)) {
    abuseTracking.set(userId, {
      messageCount: 0,
      skipCount: 0,
      reportCount: 0,
      violations: [],
      startTime: Date.now()
    });
  }
  abuseTracking.get(userId).messageCount++;

  // Check for abuse patterns
  const ip = userIPs.get(userId);
  const patterns = detectAbusePatterns(userId);
  if (patterns.length > 0) {
    handleAbuseDetection(userId, ip, patterns);
    return;
  }

  logger.info(`Text message from ${userId} to ${targetId}: ${message.substring(0, 30)}...`);

  const targetWs = connections.get(targetId);
  if (targetWs) {
    targetWs.send(
      JSON.stringify({
        type: "text-message",
        from: userId,
        message: filteredMessage,
      })
    );
  } else {
    logger.warn(`Target user ${targetId} not found`);
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
  logger.info(`User ${userId} disconnecting`);

  // Security: Track skip count
  if (pairs.has(userId)) {
    if (!abuseTracking.has(userId)) {
      abuseTracking.set(userId, {
        messageCount: 0,
        skipCount: 0,
        reportCount: 0,
        violations: [],
        startTime: Date.now()
      });
    }
    abuseTracking.get(userId).skipCount++;

    // Check for skip abuse
    const ip = userIPs.get(userId);
    const patterns = detectAbusePatterns(userId);
    if (patterns.includes("skip_abuser")) {
      handleAbuseDetection(userId, ip, patterns);
    }
  }

  const userMode = userModes.get(userId);

  connections.delete(userId);
  userModes.delete(userId);

  // Remove from appropriate queue if waiting
  if (userMode === "text") {
    const index = textWaitingQueue.indexOf(userId);
    if (index !== -1) {
      textWaitingQueue.splice(index, 1);
      logger.info(`Removed ${userId} from text chat queue`);
    }
  } else if (userMode === "video") {
    const index = videoWaitingQueue.indexOf(userId);
    if (index !== -1) {
      videoWaitingQueue.splice(index, 1);
      logger.info(`Removed ${userId} from video chat queue`);
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
        logger.info(`Put ${partnerId} back in text chat queue`);
      } else if (partnerMode === "video") {
        videoWaitingQueue.push(partnerId);
        partnerWs.send(JSON.stringify({ type: "waiting" }));
        logger.info(`Put ${partnerId} back in video chat queue`);
      }
    }
  }

  logger.info(`User ${userId} disconnected and cleaned up`);
}

function broadcastUserCount() {
  try {
    logger.info("Entering broadcastUserCount");
    // Use wss.clients to get the accurate count of ALL connected sockets
    if (!wss || !wss.clients) {
      logger.error("wss or wss.clients is undefined");
      return;
    }

    const count = wss.clients.size;
    const message = JSON.stringify({ type: "user-count", count: count });

    logger.info(`Broadcasting user count: ${count}`);

    // Broadcast to ALL connected clients, not just those in chat modes
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  } catch (error) {
    logger.error(`Error in broadcastUserCount: ${error.message}`);
    console.error(error);
  }
}

function handleTyping(data) {
  const { userId, targetId, type } = data;
  const targetWs = connections.get(targetId);

  if (targetWs) {
    targetWs.send(JSON.stringify({ type, from: userId }));
  }
}


function handleIdentify(ws, data) {
  const { userId, fingerprint } = data;

  if (!fingerprint) return;

  logger.info(`User ${userId} identified with fingerprint: ${fingerprint}`);

  // Track fingerprint
  const fingerprintCheck = trackFingerprint(fingerprint, userId);

  if (fingerprintCheck.suspicious) {
    logger.warn(`Suspicious user ${userId}: ${fingerprintCheck.reason}`);
    ws.send(JSON.stringify({
      type: "warning",
      message: "Your account has been flagged. Please use the app responsibly."
    }));
  }
}

function handleTextMessage(data) {
  const { userId, targetId, message } = data;

  // Security: Check rate limit (30 messages per minute)
  if (!checkRateLimit(userId, "messages", 30)) {
    const ws = connections.get(userId);
    if (ws) {
      ws.send(JSON.stringify({
        type: "error",
        message: "Slow down! You're sending messages too quickly."
      }));
    }
    return;
  }

  // Security: Validate message
  const validation = validateMessage(message);
  if (!validation.valid) {
    logger.warn(`Invalid message from ${userId}: ${validation.reason}`);
    const ws = connections.get(userId);
    if (ws) {
      ws.send(JSON.stringify({
        type: "error",
        message: `Message rejected: ${validation.reason}`
      }));
    }
    return;
  }

  // Security: Filter profanity
  const filteredMessage = filterProfanity(message);

  // Track abuse
  if (!abuseTracking.has(userId)) {
    abuseTracking.set(userId, {
      messageCount: 0,
      skipCount: 0,
      reportCount: 0,
      violations: [],
      startTime: Date.now()
    });
  }
  abuseTracking.get(userId).messageCount++;

  // Check for abuse patterns
  const ip = userIPs.get(userId);
  const patterns = detectAbusePatterns(userId);
  if (patterns.length > 0) {
    handleAbuseDetection(userId, ip, patterns);
    return;
  }

  logger.info(`Text message from ${userId} to ${targetId}: ${message.substring(0, 30)}...`);

  const targetWs = connections.get(targetId);
  if (targetWs) {
    targetWs.send(
      JSON.stringify({
        type: "text-message",
        from: userId,
        message: filteredMessage,
      })
    );
  } else {
    logger.warn(`Target user ${targetId} not found`);
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
  logger.info(`User ${userId} disconnecting`);

  // Security: Track skip count
  if (pairs.has(userId)) {
    if (!abuseTracking.has(userId)) {
      abuseTracking.set(userId, {
        messageCount: 0,
        skipCount: 0,
        reportCount: 0,
        violations: [],
        startTime: Date.now()
      });
    }
    abuseTracking.get(userId).skipCount++;

    // Check for skip abuse
    const ip = userIPs.get(userId);
    const patterns = detectAbusePatterns(userId);
    if (patterns.includes("skip_abuser")) {
      handleAbuseDetection(userId, ip, patterns);
    }
  }

  const userMode = userModes.get(userId);

  connections.delete(userId);
  userModes.delete(userId);

  // Remove from appropriate queue if waiting
  if (userMode === "text") {
    const index = textWaitingQueue.indexOf(userId);
    if (index !== -1) {
      textWaitingQueue.splice(index, 1);
      logger.info(`Removed ${userId} from text chat queue`);
    }
  } else if (userMode === "video") {
    const index = videoWaitingQueue.indexOf(userId);
    if (index !== -1) {
      videoWaitingQueue.splice(index, 1);
      logger.info(`Removed ${userId} from video chat queue`);
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
        logger.info(`Put ${partnerId} back in text chat queue`);
      } else if (partnerMode === "video") {
        videoWaitingQueue.push(partnerId);
        partnerWs.send(JSON.stringify({ type: "waiting" }));
        logger.info(`Put ${partnerId} back in video chat queue`);
      }
    }
  }

  logger.info(`User ${userId} disconnected and cleaned up`);
}

function broadcastUserCount() {
  totalUsers = connections.size;
  const message = JSON.stringify({ type: "user-count", count: totalUsers });

  connections.forEach((ws) => {
    ws.send(message);
  });
}

function handleTyping(data) {
  const { userId, targetId, type } = data;
  const targetWs = connections.get(targetId);

  if (targetWs) {
    targetWs.send(JSON.stringify({ type, from: userId }));
  }
}

function handleReport(data) {
  const { userId, reportedId, reason } = data;

  // Security: Check rate limit (3 reports per hour)
  if (!checkRateLimit(userId, "reports", 3)) {
    const ws = connections.get(userId);
    if (ws) {
      ws.send(JSON.stringify({
        type: "error",
        message: "You've reported too many users. Please wait before reporting again."
      }));
    }
    return;
  }

  const report = {
    timestamp: new Date().toISOString(),
    reporter: userId,
    reported: reportedId,
    reason: reason || "other"
  };

  reports.push(report);
  logger.warn(`User reported: ${JSON.stringify(report)}`);

  // Track reported user
  if (!abuseTracking.has(reportedId)) {
    abuseTracking.set(reportedId, {
      messageCount: 0,
      skipCount: 0,
      reportCount: 0,
      violations: [],
      startTime: Date.now()
    });
  }
  abuseTracking.get(reportedId).reportCount++;

  // Update fingerprint report count
  for (const [fingerprint, session] of fingerprints) {
    if (session.userIds.has(reportedId)) {
      session.reports++;
      logger.info(`Fingerprint ${fingerprint} now has ${session.reports} reports`);
    }
  }

  // Auto-ban after 5 reports
  const reportCount = reports.filter(r => r.reported === reportedId).length;
  if (reportCount >= 5) {
    const ip = userIPs.get(reportedId);
    if (ip) {
      banIP(ip, 24 * 60 * 60 * 1000, "Multiple user reports");
      logger.warn(`Auto-banned user ${reportedId} (IP: ${ip}) after ${reportCount} reports`);
      handleDisconnect(reportedId);
    }
  }

  // Optional: Auto-disconnect reported user
  // handleDisconnect(reportedId);
}
