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

const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const winston = require('winston');

// Import custom modules
const QueueManager = require('./server/QueueManager');
const SecurityManager = require('./server/SecurityManager');
const ConnectionManager = require('./server/ConnectionManager');
const MessageRouter = require('./server/MessageRouter');
const PairingManager = require('./server/PairingManager');

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Configure logging
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
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
  queueTimeout: 300000, // 5 minutes
  maxQueueSize: 10000,
  enablePriority: true
});

const securityManager = new SecurityManager({
  jwtSecret: process.env.JWT_SECRET,
  maxConnectionsPerIP: 20,
  banDuration: 86400000 // 24 hours
});

const connectionManager = new ConnectionManager({
  heartbeatInterval: 30000, // 30 seconds
  connectionTimeout: 60000, // 1 minute
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
    if (data.length > 10240) {
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
        securityManager.banIP(ip, 86400000, 'Multiple reports');
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
}, 60000); // Every minute

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
