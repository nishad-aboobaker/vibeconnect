/**
 * PairingManager - User Pairing and Session Management
 * 
 * Features:
 * - Atomic thread-safe user pairing
 * - Active session tracking
 * - Partner validation (prevent self-pairing)
 * - Mode switching support (text to video)
 * - Pair metrics and session analytics
 */

class PairingManager {
    constructor(options = {}) {
        // Active pairs: userId -> partnerId
        this.pairs = new Map();

        // Session data: pairId -> { user1, user2, mode, startTime, messageCount, switches }
        this.sessions = new Map();

        // User modes: userId -> mode (text/video/voice)
        this.userModes = new Map();

        // Mode switch tracking: partnerId -> userId (for coordinating switches)
        this.modeSwitchPending = new Map();

        // Configuration
        this.config = {
            enableMetrics: options.enableMetrics !== false,
            modeSwitchTimeout: options.modeSwitchTimeout || 30000 // 30 seconds
        };

        // Metrics
        this.metrics = {
            totalPairs: 0,
            activePairs: 0,
            totalSessions: 0,
            averageSessionDuration: 0,
            modeSwitches: 0,
            sessionDurations: [] // Store last 100 for averaging
        };
    }

    /**
     * Create a new pair
     * @param {string} user1 - First user ID
     * @param {string} user2 - Second user ID
     * @param {string} mode - Chat mode (text/video/voice)
     * @returns {Object} { success: boolean, pairId: string, error: string }
     */
    createPair(user1, user2, mode) {
        // Validation
        if (user1 === user2) {
            return { success: false, error: 'Cannot pair user with themselves' };
        }

        if (this.pairs.has(user1) || this.pairs.has(user2)) {
            return { success: false, error: 'One or both users already paired' };
        }

        if (!['text', 'video', 'voice'].includes(mode)) {
            return { success: false, error: 'Invalid mode' };
        }

        // Create pair
        this.pairs.set(user1, user2);
        this.pairs.set(user2, user1);

        // Set modes
        this.userModes.set(user1, mode);
        this.userModes.set(user2, mode);

        // Create session
        const pairId = this._generatePairId(user1, user2);
        this.sessions.set(pairId, {
            user1,
            user2,
            mode,
            startTime: Date.now(),
            messageCount: 0,
            switches: []
        });

        // Update metrics
        this.metrics.totalPairs++;
        this.metrics.activePairs = this.pairs.size / 2; // Divide by 2 since each pair has 2 entries
        this.metrics.totalSessions++;

        return { success: true, pairId };
    }

    /**
     * Get partner ID for a user
     * @param {string} userId - User identifier
     * @returns {string|null} Partner ID or null
     */
    getPair(userId) {
        return this.pairs.get(userId) || null;
    }

    /**
     * Check if user is paired
     * @param {string} userId - User identifier
     * @returns {boolean} True if paired
     */
    isPaired(userId) {
        return this.pairs.has(userId);
    }

    /**
     * Break a pair
     * @param {string} userId - Either user in the pair
     * @returns {Object} { success: boolean, partnerId: string, sessionData: Object }
     */
    breakPair(userId) {
        const partnerId = this.pairs.get(userId);
        if (!partnerId) {
            return { success: false, error: 'User not paired' };
        }

        // Get session data before deleting
        const pairId = this._generatePairId(userId, partnerId);
        const session = this.sessions.get(pairId);

        // Calculate session duration
        if (session) {
            const duration = Date.now() - session.startTime;
            this.metrics.sessionDurations.push(duration);
            if (this.metrics.sessionDurations.length > 100) {
                this.metrics.sessionDurations.shift();
            }

            // Update average
            if (this.metrics.sessionDurations.length > 0) {
                this.metrics.averageSessionDuration =
                    this.metrics.sessionDurations.reduce((a, b) => a + b, 0) /
                    this.metrics.sessionDurations.length;
            }
        }

        // Remove pair
        this.pairs.delete(userId);
        this.pairs.delete(partnerId);

        // Remove modes
        this.userModes.delete(userId);
        this.userModes.delete(partnerId);

        // Remove session
        this.sessions.delete(pairId);

        // Clean up any pending mode switches
        this.modeSwitchPending.delete(userId);
        this.modeSwitchPending.delete(partnerId);

        // Update metrics
        this.metrics.activePairs = this.pairs.size / 2;

        return {
            success: true,
            partnerId,
            sessionData: session
        };
    }

    /**
     * Get user's current mode
     * @param {string} userId - User identifier
     * @returns {string|null} Mode or null
     */
    getUserMode(userId) {
        return this.userModes.get(userId) || null;
    }

    /**
     * Switch mode for a pair (e.g., text to video)
     * @param {string} userId - User initiating switch
     * @param {string} partnerId - Partner user ID
     * @param {string} newMode - New mode to switch to
     * @returns {Object} { success: boolean, isOfferer: boolean, error: string }
     */
    switchMode(userId, partnerId, newMode) {
        // Validate pair
        if (this.pairs.get(userId) !== partnerId) {
            return { success: false, error: 'Users not paired' };
        }

        if (!['text', 'video', 'voice'].includes(newMode)) {
            return { success: false, error: 'Invalid mode' };
        }

        // Update user mode
        this.userModes.set(userId, newMode);

        // Check if partner has also requested switch
        if (this.modeSwitchPending.has(userId)) {
            // Partner already requested - this user is the answerer
            const initiatorId = this.modeSwitchPending.get(userId);
            this.modeSwitchPending.delete(userId);

            // Double-check they're still paired
            if (this.pairs.get(initiatorId) !== userId) {
                return { success: false, error: 'Pairing changed during mode switch' };
            }

            // Update partner mode
            this.userModes.set(initiatorId, newMode);

            // Update session
            const pairId = this._generatePairId(userId, initiatorId);
            const session = this.sessions.get(pairId);
            if (session) {
                session.switches.push({
                    from: session.mode,
                    to: newMode,
                    timestamp: Date.now()
                });
                session.mode = newMode;
            }

            // Update metrics
            this.metrics.modeSwitches++;

            return {
                success: true,
                isOfferer: false,
                partnerId: initiatorId,
                bothReady: true
            };
        } else {
            // This user is first to request - mark as potential offerer
            this.modeSwitchPending.set(partnerId, userId);

            // Set timeout to clean up if partner doesn't respond
            setTimeout(() => {
                if (this.modeSwitchPending.get(partnerId) === userId) {
                    this.modeSwitchPending.delete(partnerId);
                }
            }, this.config.modeSwitchTimeout);

            return {
                success: true,
                isOfferer: true,
                partnerId,
                bothReady: false,
                waiting: true
            };
        }
    }

    /**
     * Increment message count for a pair
     * @param {string} userId - User in the pair
     */
    incrementMessageCount(userId) {
        const partnerId = this.pairs.get(userId);
        if (!partnerId) return;

        const pairId = this._generatePairId(userId, partnerId);
        const session = this.sessions.get(pairId);
        if (session) {
            session.messageCount++;
        }
    }

    /**
     * Get session data for a pair
     * @param {string} userId - User in the pair
     * @returns {Object|null} Session data or null
     */
    getSessionData(userId) {
        const partnerId = this.pairs.get(userId);
        if (!partnerId) return null;

        const pairId = this._generatePairId(userId, partnerId);
        const session = this.sessions.get(pairId);

        if (!session) return null;

        return {
            ...session,
            duration: Date.now() - session.startTime,
            pairId
        };
    }

    /**
     * Get all active pairs
     * @returns {Array} Array of pair objects
     */
    getAllPairs() {
        const pairs = [];
        const processed = new Set();

        for (const [user1, user2] of this.pairs.entries()) {
            const pairId = this._generatePairId(user1, user2);
            if (processed.has(pairId)) continue;

            processed.add(pairId);
            const session = this.sessions.get(pairId);

            pairs.push({
                user1,
                user2,
                mode: this.userModes.get(user1),
                sessionData: session
            });
        }

        return pairs;
    }

    /**
     * Get pairing metrics
     * @returns {Object} Metrics data
     */
    getMetrics() {
        return {
            ...this.metrics,
            activePairs: this.pairs.size / 2,
            activeSessions: this.sessions.size,
            averageSessionDuration: Math.round(this.metrics.averageSessionDuration / 1000) + 's'
        };
    }

    /**
     * Generate unique pair ID from two user IDs
     * @private
     */
    _generatePairId(user1, user2) {
        // Sort to ensure consistent ID regardless of order
        return [user1, user2].sort().join('_');
    }

    /**
     * Clear all pairs (for testing/admin purposes)
     */
    clearAll() {
        this.pairs.clear();
        this.sessions.clear();
        this.userModes.clear();
        this.modeSwitchPending.clear();
        this.metrics.activePairs = 0;
    }

    /**
     * Shutdown pairing manager
     */
    shutdown() {
        this.clearAll();
    }
}

module.exports = PairingManager;
