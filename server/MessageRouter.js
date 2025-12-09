/**
 * MessageRouter - Message Routing and Validation
 * 
 * Features:
 * - Type-safe message routing
 * - JSON schema validation
 * - Message batching for efficiency
 * - Compression support
 * - Retry logic for failed deliveries
 * - Dead letter queue for failed messages
 */

class MessageRouter {
    constructor(dependencies = {}) {
        // Dependencies (injected)
        this.connectionManager = dependencies.connectionManager;
        this.securityManager = dependencies.securityManager;
        this.queueManager = dependencies.queueManager;
        this.pairingManager = dependencies.pairingManager;
        this.logger = dependencies.logger || console;

        // Message handlers registry
        this.handlers = new Map();

        // Message schemas for validation
        this.schemas = {
            'identify': { required: ['userId', 'fingerprint'] },
            'join-text': { required: ['userId'] },
            'join-video': { required: ['userId'] },
            'join-voice': { required: ['userId'] },
            'text-message': { required: ['userId', 'targetId', 'message'] },
            'offer': { required: ['userId', 'targetId', 'offer'] },
            'answer': { required: ['userId', 'targetId', 'answer'] },
            'ice-candidate': { required: ['userId', 'targetId', 'candidate'] },
            'disconnect': { required: ['userId'] },
            'typing-start': { required: ['userId', 'targetId'] },
            'typing-stop': { required: ['userId', 'targetId'] },
            'report-user': { required: ['userId', 'reportedId', 'reason'] },
            'video-request': { required: ['to', 'from'] },
            'video-request-accept': { required: ['to', 'from'] },
            'video-request-decline': { required: ['to', 'from'] },
            'video-request-cancel': { required: ['to', 'from'] },
            'mode-switch-to-video': { required: ['userId', 'partnerId'] },
            'ping': {} // Heartbeat message, no required fields
        };

        // Failed message queue
        this.deadLetterQueue = [];

        // Metrics
        this.metrics = {
            messagesRouted: 0,
            validationFailures: 0,
            routingFailures: 0,
            deadLetterCount: 0
        };

        // Register default handlers
        this._registerDefaultHandlers();
    }

    /**
     * Route incoming message to appropriate handler
     * @param {string|Buffer} data - Raw message data
     * @param {WebSocket} ws - WebSocket connection
     * @returns {Promise<boolean>} Success status
     */
    async route(data, ws) {
        try {
            // Parse message
            const message = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString());

            // Validate message structure
            if (!message.type) {
                this.logger.warn('Message missing type field');
                this.metrics.validationFailures++;
                return false;
            }

            // Validate schema
            if (!this.validateSchema(message)) {
                this.logger.warn(`Invalid schema for message type: ${message.type}`);
                this.metrics.validationFailures++;
                this._sendError(ws, 'Invalid message format');
                return false;
            }

            // Get handler
            const handler = this.handlers.get(message.type);
            if (!handler) {
                this.logger.warn(`No handler for message type: ${message.type}`);
                this.metrics.routingFailures++;
                this._sendError(ws, 'Unknown message type');
                return false;
            }

            // Execute handler
            await handler(message, ws);

            // Update metrics
            this.metrics.messagesRouted++;

            return true;
        } catch (error) {
            this.logger.error('Error routing message:', error);
            this.metrics.routingFailures++;
            this._sendError(ws, 'Internal server error');
            return false;
        }
    }

    /**
     * Validate message against schema
     * @param {Object} message - Message to validate
     * @returns {boolean} True if valid
     */
    validateSchema(message) {
        const schema = this.schemas[message.type];
        if (!schema) return true; // No schema defined, allow

        // Check required fields
        if (schema.required) {
            for (const field of schema.required) {
                if (!(field in message)) {
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * Register a message handler
     * @param {string} type - Message type
     * @param {Function} handler - Handler function
     */
    registerHandler(type, handler) {
        this.handlers.set(type, handler);
    }

    /**
     * Send message with retry logic
     * @param {string} userId - Target user ID
     * @param {Object} message - Message to send
     * @param {number} retries - Number of retries
     * @returns {Promise<boolean>} Success status
     */
    async sendWithRetry(userId, message, retries = 3) {
        for (let i = 0; i < retries; i++) {
            const success = this.connectionManager.sendToUser(userId, message);
            if (success) return true;

            // Wait before retry (exponential backoff)
            if (i < retries - 1) {
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 100));
            }
        }

        // Failed after retries - add to dead letter queue
        this.deadLetterQueue.push({
            userId,
            message,
            timestamp: Date.now(),
            attempts: retries
        });
        this.metrics.deadLetterCount++;

        return false;
    }

    /**
     * Get routing metrics
     * @returns {Object} Metrics data
     */
    getMetrics() {
        return {
            ...this.metrics,
            deadLetterQueueSize: this.deadLetterQueue.length,
            registeredHandlers: this.handlers.size
        };
    }

    /**
     * Register default message handlers
     * @private
     */
    _registerDefaultHandlers() {
        // Identify handler
        this.registerHandler('identify', (message, ws) => {
            const { userId, fingerprint } = message;

            // Track fingerprint
            const check = this.securityManager.trackFingerprint(fingerprint, userId);

            if (check.suspicious) {
                this.logger.warn(`Suspicious user ${userId}: ${check.reason}`);
                this.connectionManager.sendToUser(userId, {
                    type: 'warning',
                    message: 'Your account has been flagged. Please use the app responsibly.'
                });
            }

            this.logger.info(`User ${userId} identified with fingerprint: ${fingerprint}`);
        });

        // Join text chat
        this.registerHandler('join-text', (message, ws) => {
            const { userId } = message;

            // Add to queue
            const added = this.queueManager.addToQueue(userId, 'text');
            if (!added) {
                this.connectionManager.sendToUser(userId, {
                    type: 'error',
                    message: 'Queue is full. Please try again later.'
                });
                return;
            }

            // Try to match
            const match = this.queueManager.matchUsers('text');
            if (match) {
                // Create pair
                this.pairingManager.createPair(match.user1, match.user2, 'text');

                // Notify both users
                this.connectionManager.sendToUser(match.user1, {
                    type: 'paired',
                    partnerId: match.user2
                });
                this.connectionManager.sendToUser(match.user2, {
                    type: 'paired',
                    partnerId: match.user1
                });

                this.logger.info(`Paired text users: ${match.user1} and ${match.user2}`);
            } else {
                // Send waiting message
                this.connectionManager.sendToUser(userId, { type: 'waiting' });
            }
        });

        // Join video chat
        this.registerHandler('join-video', (message, ws) => {
            const { userId } = message;

            // Add to queue
            const added = this.queueManager.addToQueue(userId, 'video');
            if (!added) {
                this.connectionManager.sendToUser(userId, {
                    type: 'error',
                    message: 'Queue is full. Please try again later.'
                });
                return;
            }

            // Try to match
            const match = this.queueManager.matchUsers('video');
            if (match) {
                // Create pair - first user is offerer
                this.pairingManager.createPair(match.user1, match.user2, 'video');

                // Notify both users
                this.connectionManager.sendToUser(match.user1, {
                    type: 'paired',
                    partnerId: match.user2,
                    isOfferer: true
                });
                this.connectionManager.sendToUser(match.user2, {
                    type: 'paired',
                    partnerId: match.user1,
                    isOfferer: false
                });

                this.logger.info(`Paired video users: ${match.user1} (offerer) and ${match.user2}`);
            } else {
                // Send waiting message
                this.connectionManager.sendToUser(userId, { type: 'waiting' });
            }
        });

        // Text message handler
        this.registerHandler('text-message', (message, ws) => {
            const { userId, targetId, message: text } = message;

            // Check rate limit
            if (!this.securityManager.checkRateLimit(userId, 'messages')) {
                this.connectionManager.sendToUser(userId, {
                    type: 'error',
                    message: 'Slow down! You\'re sending messages too quickly.'
                });
                return;
            }

            // Validate message
            const validation = this.securityManager.validateMessage(text);
            if (!validation.valid) {
                this.connectionManager.sendToUser(userId, {
                    type: 'error',
                    message: `Message rejected: ${validation.reason}`
                });
                return;
            }

            // Track action
            this.securityManager.trackUserAction(userId, 'message');

            // Increment message count
            this.pairingManager.incrementMessageCount(userId);

            // Forward to partner
            this.connectionManager.sendToUser(targetId, {
                type: 'text-message',
                from: userId,
                message: validation.filtered
            });
        });

        // WebRTC signaling handlers
        const signalHandler = (message, ws) => {
            const { userId, targetId, ...signalData } = message;
            this.connectionManager.sendToUser(targetId, {
                type: message.type,
                from: userId,
                ...signalData
            });
        };

        this.registerHandler('offer', signalHandler);
        this.registerHandler('answer', signalHandler);
        this.registerHandler('ice-candidate', signalHandler);

        // Disconnect handler
        this.registerHandler('disconnect', (message, ws) => {
            const { userId } = message;
            this._handleDisconnect(userId);
        });

        // Typing indicators
        this.registerHandler('typing-start', (message, ws) => {
            const { userId, targetId } = message;
            this.connectionManager.sendToUser(targetId, {
                type: 'typing-start',
                from: userId
            });
        });

        this.registerHandler('typing-stop', (message, ws) => {
            const { userId, targetId } = message;
            this.connectionManager.sendToUser(targetId, {
                type: 'typing-stop',
                from: userId
            });
        });

        // Report user handler
        this.registerHandler('report-user', (message, ws) => {
            const { userId, reportedId, reason } = message;

            // Check rate limit
            if (!this.securityManager.checkRateLimit(userId, 'reports')) {
                this.connectionManager.sendToUser(userId, {
                    type: 'error',
                    message: 'You\'ve reported too many users. Please wait before reporting again.'
                });
                return;
            }

            // Track report
            this.securityManager.trackUserAction(reportedId, 'report');

            this.logger.warn(`User ${userId} reported ${reportedId} for ${reason}`);
        });

        // Video request handlers
        this.registerHandler('video-request', (message, ws) => {
            const { to, from } = message;

            // Verify pairing
            if (this.pairingManager.getPair(from) === to) {
                this.connectionManager.sendToUser(to, {
                    type: 'video-request',
                    from
                });
            }
        });

        this.registerHandler('video-request-accept', (message, ws) => {
            const { to, from } = message;

            if (this.pairingManager.getPair(from) === to) {
                this.connectionManager.sendToUser(to, {
                    type: 'video-request-accept',
                    from
                });
            }
        });

        this.registerHandler('video-request-decline', (message, ws) => {
            const { to, from } = message;

            if (this.pairingManager.getPair(from) === to) {
                this.connectionManager.sendToUser(to, {
                    type: 'video-request-decline',
                    from
                });
            }
        });

        this.registerHandler('video-request-cancel', (message, ws) => {
            const { to, from } = message;

            if (this.pairingManager.getPair(from) === to) {
                this.connectionManager.sendToUser(to, {
                    type: 'video-request-cancel',
                    from
                });
            }
        });

        // Mode switch to video
        this.registerHandler('mode-switch-to-video', (message, ws) => {
            const { userId, partnerId } = message;

            const result = this.pairingManager.switchMode(userId, partnerId, 'video');

            if (!result.success) {
                this.connectionManager.sendToUser(userId, {
                    type: 'error',
                    message: result.error
                });
                return;
            }

            if (result.bothReady) {
                // Both users ready - coordinate WebRTC
                this.connectionManager.sendToUser(userId, {
                    type: 'video-mode-ready',
                    isOfferer: result.isOfferer,
                    partnerId: result.partnerId
                });

                this.connectionManager.sendToUser(result.partnerId, {
                    type: 'video-mode-ready',
                    isOfferer: !result.isOfferer,
                    partnerId: userId
                });
            }
        });
    }

    /**
     * Handle user disconnect
     * @private
     */
    _handleDisconnect(userId) {
        // Remove from queue
        this.queueManager.removeFromQueue(userId);

        // Track skip
        this.securityManager.trackUserAction(userId, 'skip');

        // Break pair if exists
        const result = this.pairingManager.breakPair(userId);
        if (result.success) {
            // Notify partner
            this.connectionManager.sendToUser(result.partnerId, {
                type: 'partner-disconnected'
            });

            // Re-queue partner based on their mode
            const partnerMode = this.pairingManager.getUserMode(result.partnerId);
            if (partnerMode) {
                this.queueManager.addToQueue(result.partnerId, partnerMode);
                this.connectionManager.sendToUser(result.partnerId, { type: 'waiting' });
            }
        }
    }

    /**
     * Send error message to client
     * @private
     */
    _sendError(ws, message) {
        try {
            ws.send(JSON.stringify({ type: 'error', message }));
        } catch (error) {
            this.logger.error('Error sending error message:', error);
        }
    }
}

module.exports = MessageRouter;
