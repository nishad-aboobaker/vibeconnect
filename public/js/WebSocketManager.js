/**
 * WebSocketManager - Robust WebSocket Connection Handler
 * 
 * Features:
 * - Auto-reconnect with exponential backoff
 * - Message queue for offline mode
 * - Connection health monitoring
 * - Heartbeat ping/pong
 * - Event-based message handling
 * - Connection state machine
 */

class WebSocketManager {
    constructor(stateManager, options = {}) {
        this.stateManager = stateManager;

        // Configuration
        this.config = {
            url: this.getWebSocketUrl(),
            reconnectDelay: options.reconnectDelay || 1000,
            maxReconnectDelay: options.maxReconnectDelay || 30000,
            reconnectDecay: options.reconnectDecay || 1.5,
            heartbeatInterval: options.heartbeatInterval || 30000,
            messageTimeout: options.messageTimeout || 5000
        };

        // Connection state
        this.ws = null;
        this.reconnectAttempts = 0;
        this.reconnectTimeout = null;
        this.heartbeatInterval = null;
        this.lastHeartbeat = null;

        // Message queue for offline messages
        this.messageQueue = [];
        this.maxQueueSize = 100;

        // Event handlers
        this.eventHandlers = new Map();

        // Pending messages (waiting for response)
        this.pendingMessages = new Map();
        this.messageIdCounter = 0;
    }

    /**
     * Get WebSocket URL based on environment
     * @private
     */
    getWebSocketUrl() {
        if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
            return 'wss://vibeconnect-4crg.onrender.com/';
        }
        return 'ws://localhost:3000';
    }

    /**
     * Connect to WebSocket server
     */
    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('Already connected');
            return;
        }

        console.log('Connecting to WebSocket...');
        this.stateManager.set('connectionStatus', 'connecting');

        try {
            this.ws = new WebSocket(this.config.url);
            this.setupEventHandlers();
        } catch (error) {
            console.error('Error creating WebSocket:', error);
            this.handleConnectionError();
        }
    }

    /**
     * Setup WebSocket event handlers
     * @private
     */
    setupEventHandlers() {
        this.ws.onopen = () => {
            console.log('✅ Connected to server');
            this.stateManager.setMultiple({
                connected: true,
                connectionStatus: 'connected'
            });

            // Reset reconnect attempts
            this.reconnectAttempts = 0;

            // Start heartbeat
            this.startHeartbeat();

            // Send identify message
            this.sendIdentify();

            // Process queued messages
            this.processMessageQueue();

            // Emit connect event
            this.emit('connect');
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleMessage(data);
            } catch (error) {
                console.error('Error parsing message:', error);
            }
        };

        this.ws.onclose = (event) => {
            console.log('❌ Disconnected from server');
            this.stateManager.setMultiple({
                connected: false,
                connectionStatus: 'disconnected'
            });

            // Stop heartbeat
            this.stopHeartbeat();

            // Emit disconnect event
            this.emit('disconnect', event);

            // Attempt reconnect if not a normal closure
            if (event.code !== 1000) {
                this.scheduleReconnect();
            }
        };

        this.ws.onerror = (error) => {
            console.error('❌ WebSocket error:', error);
            this.stateManager.set('connectionStatus', 'error');
            this.emit('error', error);
        };
    }

    /**
     * Send identify message to server
     * @private
     */
    sendIdentify() {
        const userId = this.stateManager.get('userId');
        const fingerprint = this.stateManager.get('fingerprint');

        if (userId && fingerprint) {
            this.send({
                type: 'identify',
                userId,
                fingerprint
            });
        }
    }

    /**
     * Handle incoming message
     * @private
     */
    handleMessage(data) {
        console.log('📨 Received:', data.type);

        // Check if this is a response to a pending message
        if (data.messageId && this.pendingMessages.has(data.messageId)) {
            const { resolve } = this.pendingMessages.get(data.messageId);
            resolve(data);
            this.pendingMessages.delete(data.messageId);
            return;
        }

        // Emit message event
        this.emit('message', data);

        // Emit specific event for message type
        this.emit(data.type, data);
    }

    /**
     * Send message to server
     * @param {Object} message - Message to send
     * @param {boolean} queue - Whether to queue if offline
     * @returns {boolean} True if sent successfully
     */
    send(message, queue = true) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify(message));
                return true;
            } catch (error) {
                console.error('Error sending message:', error);
                if (queue) {
                    this.queueMessage(message);
                }
                return false;
            }
        } else {
            console.warn('WebSocket not open, message not sent');
            if (queue) {
                this.queueMessage(message);
            }
            return false;
        }
    }

    /**
     * Send message and wait for response
     * @param {Object} message - Message to send
     * @param {number} timeout - Timeout in milliseconds
     * @returns {Promise} Promise that resolves with response
     */
    sendAndWait(message, timeout = this.config.messageTimeout) {
        return new Promise((resolve, reject) => {
            const messageId = ++this.messageIdCounter;
            message.messageId = messageId;

            // Store pending message
            this.pendingMessages.set(messageId, { resolve, reject });

            // Set timeout
            const timeoutId = setTimeout(() => {
                if (this.pendingMessages.has(messageId)) {
                    this.pendingMessages.delete(messageId);
                    reject(new Error('Message timeout'));
                }
            }, timeout);

            // Send message
            if (!this.send(message, false)) {
                clearTimeout(timeoutId);
                this.pendingMessages.delete(messageId);
                reject(new Error('Failed to send message'));
            }
        });
    }

    /**
     * Queue message for later sending
     * @private
     */
    queueMessage(message) {
        if (this.messageQueue.length >= this.maxQueueSize) {
            console.warn('Message queue full, dropping oldest message');
            this.messageQueue.shift();
        }
        this.messageQueue.push(message);
    }

    /**
     * Process queued messages
     * @private
     */
    processMessageQueue() {
        while (this.messageQueue.length > 0) {
            const message = this.messageQueue.shift();
            this.send(message, false);
        }
    }

    /**
     * Schedule reconnect with exponential backoff
     * @private
     */
    scheduleReconnect() {
        if (this.reconnectTimeout) return;

        const delay = Math.min(
            this.config.reconnectDelay * Math.pow(this.config.reconnectDecay, this.reconnectAttempts),
            this.config.maxReconnectDelay
        );

        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);
        this.stateManager.set('connectionStatus', 'reconnecting');

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.reconnectAttempts++;
            this.connect();
        }, delay);
    }

    /**
     * Handle connection error
     * @private
     */
    handleConnectionError() {
        this.stateManager.setMultiple({
            connected: false,
            connectionStatus: 'error'
        });
        this.scheduleReconnect();
    }

    /**
     * Start heartbeat
     * @private
     */
    startHeartbeat() {
        this.stopHeartbeat();

        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                // Check if we received a heartbeat recently
                if (this.lastHeartbeat && Date.now() - this.lastHeartbeat > this.config.heartbeatInterval * 2) {
                    console.warn('No heartbeat received, connection may be dead');
                    this.ws.close();
                    return;
                }

                // Send ping (browser WebSocket API doesn't expose ping, so we send a custom message)
                this.send({ type: 'ping' }, false);
                this.lastHeartbeat = Date.now();
            }
        }, this.config.heartbeatInterval);
    }

    /**
     * Stop heartbeat
     * @private
     */
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    /**
     * Register event handler
     * @param {string} event - Event name
     * @param {Function} handler - Event handler function
     * @returns {Function} Unsubscribe function
     */
    on(event, handler) {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, new Set());
        }

        this.eventHandlers.get(event).add(handler);

        // Return unsubscribe function
        return () => {
            this.eventHandlers.get(event)?.delete(handler);
        };
    }

    /**
     * Emit event
     * @private
     */
    emit(event, data) {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            handlers.forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    console.error(`Error in event handler for ${event}:`, error);
                }
            });
        }
    }

    /**
     * Disconnect from server
     */
    disconnect() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        this.stopHeartbeat();

        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }

        this.stateManager.setMultiple({
            connected: false,
            connectionStatus: 'disconnected'
        });
    }

    /**
     * Get connection status
     * @returns {string} Connection status
     */
    getStatus() {
        if (!this.ws) return 'disconnected';

        switch (this.ws.readyState) {
            case WebSocket.CONNECTING:
                return 'connecting';
            case WebSocket.OPEN:
                return 'connected';
            case WebSocket.CLOSING:
                return 'closing';
            case WebSocket.CLOSED:
                return 'disconnected';
            default:
                return 'unknown';
        }
    }

    /**
     * Check if connected
     * @returns {boolean} True if connected
     */
    isConnected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WebSocketManager;
}
