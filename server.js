/**
 * VibeConnect Server - Refactored with Modular Architecture
 * 
 * High-performance anonymous chat server with enterprise-grade security
 * 
 * Features:
 * - O(1) user matching with priority queues
 * - JWT authentication and advanced fingerprinting
 * - Token bucket rate limiting
 * - DDoS protection and IP banning
 * - WebRTC signaling for video/voice chat
 * - Comprehensive metrics and monitoring
 */

// Load environment variables FIRST
require('dotenv').config();

const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const crypto = require('crypto');

// Import custom modules
const QueueManager = require('./server/QueueManager');
const SecurityManager = require('./server/SecurityManager');
const ConnectionManager = require('./server/ConnectionManager');
const MessageRouter = require('./server/MessageRouter');
const PairingManager = require('./server/PairingManager');
const CONSTANTS = require('./server/constants');

// Validate critical environment variables
if (!process.env.JWT_SECRET) {
  console.error('❌ CRITICAL ERROR: JWT_SECRET environment variable is not set!');
  console.error('Generate a secure secret with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

if (process.env.JWT_SECRET.length < CONSTANTS.MIN_JWT_SECRET_LENGTH) {
  console.error(`❌ CRITICAL ERROR: JWT_SECRET must be at least ${CONSTANTS.MIN_JWT_SECRET_LENGTH} characters long!`);
  process.exit(1);
}

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Configure logging with rotation
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    // Error log with rotation
    new DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '20m',
      maxFiles: '14d',
      zippedArchive: true
    }),
    // Combined log with rotation
    new DailyRotateFile({
      filename: 'logs/combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      zippedArchive: true
    }),
    // Console output
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Security Middleware

// HTTPS Enforcement (only in production)
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// Content Security Policy Headers
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "connect-src 'self' ws: wss:; " +
    "img-src 'self' data:; " +
    "media-src 'self'"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    connections: connectionManager.getConnectionCount(),
    queues: queueManager.getQueueStats(),
    memory: process.memoryUsage()
  });
});

// Metrics endpoint (optional - for monitoring)
app.get('/metrics', (req, res) => {
  res.json({
    connections: connectionManager.getMetrics(),
    queues: queueManager.getQueueStats(),
    security: securityManager.getSecurityStats(),
    pairing: pairingManager.getMetrics(),
    routing: messageRouter.getMetrics()
  });
});

// Start HTTP server
const server = app.listen(port, () => {
  logger.info(`🚀 VibeConnect server running on port ${port}`);
  logger.info(`📊 Health check: http://localhost:${port}/health`);
  logger.info(`📈 Metrics: http://localhost:${port}/metrics`);
});

// Initialize WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// Initialize managers
const queueManager = new QueueManager({
  queueTimeout: parseInt(process.env.QUEUE_TIMEOUT_MS) || CONSTANTS.DEFAULT_QUEUE_TIMEOUT,
  maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE) || CONSTANTS.DEFAULT_MAX_QUEUE_SIZE,
  enablePriority: true
});

const securityManager = new SecurityManager({
  jwtSecret: process.env.JWT_SECRET, // Now guaranteed to exist
  maxConnectionsPerIP: parseInt(process.env.MAX_CONNECTIONS_PER_IP) || 20,
  banDuration: parseInt(process.env.BAN_DURATION_MS) || CONSTANTS.DEFAULT_BAN_DURATION
});

const connectionManager = new ConnectionManager({
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL_MS) || CONSTANTS.DEFAULT_HEARTBEAT_INTERVAL,
  connectionTimeout: parseInt(process.env.CONNECTION_TIMEOUT_MS) || CONSTANTS.DEFAULT_CONNECTION_TIMEOUT,
  maxConnectionsPerUser: 1
});

const pairingManager = new PairingManager({
  enableMetrics: true,
  modeSwitchTimeout: 30000
});

const messageRouter = new MessageRouter({
  connectionManager,
  securityManager,
  queueManager,
  pairingManager,
  logger
});

// Get client IP helper
function getClientIP(request) {
  return (
    request.headers['x-forwarded-for']?.split(',')[0] ||
    request.headers['x-real-ip'] ||
    request.socket.remoteAddress ||
    request.connection.remoteAddress
  );
}

// WebSocket upgrade handler
server.on('upgrade', (request, socket, head) => {
  const ip = getClientIP(request);

  // Check if IP is banned
  if (securityManager.isIPBanned(ip)) {
    logger.warn(`🚫 Rejected connection from banned IP: ${ip}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  // Check connection rate limit
  if (!securityManager.trackIPConnection(ip)) {
    logger.warn(`⚠️ Connection rate limit exceeded for IP: ${ip}`);
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }

  // Upgrade to WebSocket
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.ip = ip;
    wss.emit('connection', ws, request);
  });
});

// WebSocket connection handler
wss.on('connection', (ws) => {
  logger.info(`✅ New WebSocket connection from IP: ${ws.ip}`);

  let userId = null;

  // Broadcast user count
  broadcastUserCount();

  // Message handler
  ws.on('message', async (data) => {
    // Security: Check message size (max 10KB)
    if (data.length > CONSTANTS.MAX_MESSAGE_SIZE) {
      logger.warn(`⚠️ Oversized message from IP ${ws.ip}: ${data.length} bytes`);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Message too large'
      }));
      return;
    }

    try {
      // Parse message to extract userId
      const message = JSON.parse(data.toString());

      // If this is an identify message, register the connection
      if (message.type === 'identify' && message.userId) {
        userId = message.userId;
        connectionManager.addConnection(userId, ws, { ip: ws.ip });
        logger.info(`👤 User ${userId} identified from IP: ${ws.ip}`);
      }

      // Route message
      await messageRouter.route(data, ws);

    } catch (error) {
      logger.error(`❌ Error processing message from IP ${ws.ip}:`, error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });

  // Close handler
  ws.on('close', () => {
    if (userId) {
      logger.info(`👋 User ${userId} disconnected from IP: ${ws.ip}`);

      // Handle disconnect
      handleUserDisconnect(userId);

      // Remove connection
      connectionManager.removeConnection(userId);
    }

    // Broadcast updated user count
    broadcastUserCount();
  });

  // Error handler
  ws.on('error', (error) => {
    logger.error(`❌ WebSocket error for IP ${ws.ip}:`, error);
  });
});

/**
 * Handle user disconnect
 */
function handleUserDisconnect(userId) {
  // Remove from queue
  queueManager.removeFromQueue(userId);

  // Track skip action
  securityManager.trackUserAction(userId, 'skip');

  // Check for abuse patterns
  const patterns = securityManager.detectAbusePatterns(userId);
  if (patterns.length > 0) {
    logger.warn(`⚠️ Abuse patterns detected for user ${userId}: ${patterns.join(', ')}`);

    // Handle abuse (ban if harasser)
    if (patterns.includes('harasser')) {
      const ip = connectionManager.getConnection(userId)?.metadata?.ip;
      if (ip) {
        securityManager.banIP(ip, CONSTANTS.DEFAULT_BAN_DURATION, 'Multiple reports');
        logger.warn(`🚫 Banned IP ${ip} for harassment`);
      }
    }
  }

  // Break pair if exists
  const result = pairingManager.breakPair(userId);
  if (result.success) {
    const partnerId = result.partnerId;

    // Notify partner
    connectionManager.sendToUser(partnerId, {
      type: 'partner-disconnected'
    });

    // Get partner's mode
    const partnerMode = result.sessionData?.mode;
    if (partnerMode) {
      // Re-queue partner
      queueManager.addToQueue(partnerId, partnerMode);
      connectionManager.sendToUser(partnerId, { type: 'waiting' });

      logger.info(`🔄 Re-queued user ${partnerId} in ${partnerMode} mode`);
    }
  }
}

/**
 * Broadcast user count to all connected clients
 */
function broadcastUserCount() {
  try {
    const count = connectionManager.getConnectionCount();
    const message = JSON.stringify({ type: 'user-count', count });

    connectionManager.broadcastToAll(message);

    logger.debug(`📊 Broadcasted user count: ${count}`);
  } catch (error) {
    logger.error('❌ Error broadcasting user count:', error);
  }
}

// Periodic cleanup tasks
setInterval(() => {
  logger.debug('🧹 Running periodic cleanup...');

  // Clean up security data
  securityManager.cleanup();

  // Broadcast user count
  broadcastUserCount();
}, CONSTANTS.CLEANUP_INTERVAL_MS); // Every minute

// Graceful shutdown
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  logger.info('🛑 Shutting down gracefully...');

  // Stop accepting new connections
  server.close(() => {
    logger.info('✅ HTTP server closed');
  });

  // Close all WebSocket connections
  connectionManager.closeAll();

  // Shutdown managers
  queueManager.shutdown();
  connectionManager.shutdown();
  pairingManager.shutdown();

  logger.info('👋 Shutdown complete');
  process.exit(0);
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('❌ Uncaught Exception:', error);
  shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

logger.info('✨ VibeConnect server initialized successfully');
