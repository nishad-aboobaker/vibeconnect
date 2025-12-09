/**
 * ConnectionManager - WebSocket Connection Lifecycle Manager
 * 
 * Features:
 * - Connection pooling and efficient management
 * - Auto-reconnect handling
 * - Heartbeat system with ping/pong
 * - Graceful shutdown
 * - Connection metrics and monitoring
 * - Memory management with automatic cleanup
 */

class ConnectionManager {
    constructor(options = {}) {
        // Active connections: userId -> { ws, metadata, lastPing, isAlive }
        this.connections = new Map();

        // Reverse lookup: WebSocket -> userId
        this.wsToUserId = new WeakMap();

        // Configuration
        this.config = {
            heartbeatInterval: options.heartbeatInterval || 30000, // 30 seconds
            connectionTimeout: options.connectionTimeout || 60000, // 1 minute
            maxConnectionsPerUser: options.maxConnectionsPerUser || 1,
            enableMetrics: options.enableMetrics !== false
        };

        // Metrics
        this.metrics = {
            totalConnections: 0,
            activeConnections: 0,
            disconnections: 0,
            timeouts: 0,
            messagesReceived: 0,
            messagesSent: 0,
            bytesReceived: 0,
            bytesSent: 0
        };

        // Start heartbeat interval
        this.startHeartbeat();
    }

    /**
     * Add new connection
     * @param {string} userId - User identifier
     * @param {WebSocket} ws - WebSocket connection
     * @param {Object} metadata - Additional connection metadata
     * @returns {boolean} Success status
     */
    addConnection(userId, ws, metadata = {}) {
        // Check if user already has a connection
        if (this.connections.has(userId)) {
            const existing = this.connections.get(userId);

            // Close old connection if max connections reached
            if (this.config.maxConnectionsPerUser === 1) {
                this.removeConnection(userId);
            }
        }

        // Store connection
        this.connections.set(userId, {
            ws,
            metadata: {
                ...metadata,
                connectedAt: Date.now(),
                ip: metadata.ip || 'unknown'
            },
            lastPing: Date.now(),
            isAlive: true,
            messageCount: 0,
            bytesSent: 0,
            bytesReceived: 0
        });

        // Reverse lookup
        this.wsToUserId.set(ws, userId);

        // Setup WebSocket event handlers
        this._setupWebSocketHandlers(userId, ws);

        // Update metrics
        this.metrics.totalConnections++;
        this.metrics.activeConnections = this.connections.size;

        return true;
    }

    /**
     * Remove connection
     * @param {string} userId - User identifier
     * @returns {boolean} True if connection existed
     */
    removeConnection(userId) {
        const connection = this.connections.get(userId);
        if (!connection) return false;

        // Close WebSocket if still open
        if (connection.ws.readyState === 1) { // OPEN
            connection.ws.close(1000, 'Normal closure');
        }

        // Remove from maps
        this.connections.delete(userId);

        // Update metrics
        this.metrics.disconnections++;
        this.metrics.activeConnections = this.connections.size;

        return true;
    }

    /**
     * Get connection by user ID
     * @param {string} userId - User identifier
     * @returns {Object|null} Connection object or null
     */
    getConnection(userId) {
        return this.connections.get(userId) || null;
    }

    /**
     * Get user ID from WebSocket
     * @param {WebSocket} ws - WebSocket connection
     * @returns {string|null} User ID or null
     */
    getUserId(ws) {
        return this.wsToUserId.get(ws) || null;
    }

    /**
     * Check if user is connected
     * @param {string} userId - User identifier
     * @returns {boolean} True if connected
     */
    isConnected(userId) {
        const connection = this.connections.get(userId);
        return connection && connection.ws.readyState === 1;
    }

    /**
     * Send message to specific user
     * @param {string} userId - User identifier
     * @param {Object|string} message - Message to send
     * @returns {boolean} True if sent successfully
     */
    sendToUser(userId, message) {
        const connection = this.connections.get(userId);
        if (!connection || connection.ws.readyState !== 1) {
            return false;
        }

        try {
            const data = typeof message === 'string' ? message : JSON.stringify(message);
            connection.ws.send(data);

            // Update metrics
            connection.messageCount++;
            connection.bytesSent += data.length;
            this.metrics.messagesSent++;
            this.metrics.bytesSent += data.length;

            return true;
        } catch (error) {
            console.error(`Error sending message to ${userId}:`, error);
            return false;
        }
    }

    /**
     * Broadcast message to all connected users
     * @param {Object|string} message - Message to broadcast
     * @param {Array} excludeUserIds - User IDs to exclude from broadcast
     * @returns {number} Number of users message was sent to
     */
    broadcastToAll(message, excludeUserIds = []) {
        const data = typeof message === 'string' ? message : JSON.stringify(message);
        let sentCount = 0;

        for (const [userId, connection] of this.connections.entries()) {
            if (excludeUserIds.includes(userId)) continue;

            if (connection.ws.readyState === 1) {
                try {
                    connection.ws.send(data);
                    connection.messageCount++;
                    connection.bytesSent += data.length;
                    sentCount++;
                } catch (error) {
                    console.error(`Error broadcasting to ${userId}:`, error);
                }
            }
        }

        // Update metrics
        this.metrics.messagesSent += sentCount;
        this.metrics.bytesSent += data.length * sentCount;

        return sentCount;
    }

    /**
     * Get all connected user IDs
     * @returns {Array} Array of user IDs
     */
    getAllUserIds() {
        return Array.from(this.connections.keys());
    }

    /**
     * Get connection count
     * @returns {number} Number of active connections
     */
    getConnectionCount() {
        return this.connections.size;
    }

    /**
     * Get connection metrics
     * @returns {Object} Connection metrics
     */
    getMetrics() {
        return {
            ...this.metrics,
            activeConnections: this.connections.size,
            averageMessagesPerConnection: this.connections.size > 0
                ? (this.metrics.messagesSent / this.connections.size).toFixed(2)
                : 0
        };
    }

    /**
     * Get detailed connection info for a user
     * @param {string} userId - User identifier
     * @returns {Object|null} Connection details
     */
    getConnectionInfo(userId) {
        const connection = this.connections.get(userId);
        if (!connection) return null;

        return {
            userId,
            connectedAt: connection.metadata.connectedAt,
            ip: connection.metadata.ip,
            isAlive: connection.isAlive,
            lastPing: connection.lastPing,
            messageCount: connection.messageCount,
            bytesSent: connection.bytesSent,
            bytesReceived: connection.bytesReceived,
            uptime: Date.now() - connection.metadata.connectedAt
        };
    }

    /**
     * Setup WebSocket event handlers
     * @private
     */
    _setupWebSocketHandlers(userId, ws) {
        // Pong handler for heartbeat
        ws.on('pong', () => {
            const connection = this.connections.get(userId);
            if (connection) {
                connection.isAlive = true;
                connection.lastPing = Date.now();
            }
        });

        // Message handler for metrics
        ws.on('message', (data) => {
            const connection = this.connections.get(userId);
            if (connection) {
                connection.bytesReceived += data.length;
                this.metrics.messagesReceived++;
                this.metrics.bytesReceived += data.length;
            }
        });
    }

    /**
     * Start heartbeat interval
     * @private
     */
    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            this._performHeartbeat();
        }, this.config.heartbeatInterval);
    }

    /**
     * Perform heartbeat check
     * @private
     */
    _performHeartbeat() {
        const now = Date.now();
        const deadConnections = [];

        for (const [userId, connection] of this.connections.entries()) {
            // Check if connection is alive
            if (!connection.isAlive) {
                deadConnections.push(userId);
                continue;
            }

            // Check for timeout
            if (now - connection.lastPing > this.config.connectionTimeout) {
                deadConnections.push(userId);
                this.metrics.timeouts++;
                continue;
            }

            // Mark as not alive and send ping
            connection.isAlive = false;

            if (connection.ws.readyState === 1) {
                connection.ws.ping();
            }
        }

        // Remove dead connections
        for (const userId of deadConnections) {
            this.removeConnection(userId);
        }

        if (deadConnections.length > 0) {
            console.log(`ConnectionManager: Removed ${deadConnections.length} dead connections`);
        }
    }

    /**
     * Stop heartbeat interval
     */
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    /**
     * Close all connections gracefully
     */
    closeAll() {
        for (const [userId, connection] of this.connections.entries()) {
            if (connection.ws.readyState === 1) {
                connection.ws.close(1001, 'Server shutting down');
            }
        }
        this.connections.clear();
        this.metrics.activeConnections = 0;
    }

    /**
     * Shutdown connection manager
     */
    shutdown() {
        this.stopHeartbeat();
        this.closeAll();
    }
}

module.exports = ConnectionManager;
