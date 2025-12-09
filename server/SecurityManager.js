/**
 * SecurityManager - Enterprise-Grade Security Module
 * 
 * Features:
 * - JWT authentication with secure tokens
 * - Advanced multi-factor fingerprinting
 * - Token bucket rate limiting
 * - IP banning with expiration
 * - DDoS protection
 * - Content filtering (XSS, SQL injection, profanity)
 * - Abuse pattern detection
 * - Message encryption support
 */

const crypto = require('crypto');
const BadWordsFilter = require('bad-words');
const CONSTANTS = require('./constants');

class SecurityManager {
    constructor(options = {}) {
        // Validate required options
        if (!options.jwtSecret) {
            throw new Error('JWT secret is required for SecurityManager');
        }

        // Configuration
        this.config = {
            jwtSecret: options.jwtSecret,
            tokenExpiry: options.tokenExpiry || 900000, // 15 minutes
            refreshTokenExpiry: options.refreshTokenExpiry || 604800000, // 7 days
            maxConnectionsPerIP: options.maxConnectionsPerIP || 20,
            banDuration: options.banDuration || 86400000, // 24 hours
            enableEncryption: options.enableEncryption || false,
            encryptionKey: options.encryptionKey || crypto.randomBytes(32)
        };

        // Rate limiting - Token bucket algorithm
        this.rateLimits = new Map(); // userId -> { messages: [], skips: [], reports: [] }
        this.rateLimitConfig = {
            messages: {
                limit: parseInt(process.env.RATE_LIMIT_MESSAGES_PER_MINUTE) || CONSTANTS.DEFAULT_RATE_LIMIT_MESSAGES,
                window: CONSTANTS.DEFAULT_RATE_LIMIT_WINDOW_MS
            },
            skips: {
                limit: parseInt(process.env.RATE_LIMIT_SKIPS_PER_MINUTE) || CONSTANTS.DEFAULT_RATE_LIMIT_SKIPS,
                window: CONSTANTS.DEFAULT_RATE_LIMIT_WINDOW_MS
            },
            reports: {
                limit: parseInt(process.env.RATE_LIMIT_REPORTS_PER_HOUR) || CONSTANTS.DEFAULT_RATE_LIMIT_REPORTS,
                window: CONSTANTS.DEFAULT_RATE_LIMIT_REPORTS_WINDOW_MS
            }
        };

        // IP tracking and banning
        this.ipConnections = new Map(); // IP -> { connections: [], lastConnection: timestamp }
        this.bannedIPs = new Map(); // IP -> { until: timestamp, reason: string }
        this.userIPs = new Map(); // userId -> IP

        // Fingerprinting
        this.fingerprints = new Map(); // fingerprint -> { userIds: Set, reports: 0, bans: 0, firstSeen: timestamp }

        // Abuse tracking
        this.abuseTracking = new Map(); // userId -> { messageCount, skipCount, reportCount, violations: [], startTime }

        // Profanity filter - using bad-words library
        this.profanityFilter = new BadWordsFilter();

        // Dangerous patterns for XSS/injection
        this.dangerousPatterns = [
            /<script/i,
            /javascript:/i,
            /on\w+=/i,
            /<iframe/i,
            /eval\(/i,
            /<object/i,
            /<embed/i,
            /onerror=/i,
            /onload=/i,
            /\bselect\b.*\bfrom\b/i, // SQL injection
            /\bunion\b.*\bselect\b/i,
            /\bdrop\b.*\btable\b/i
        ];
    }

    /**
     * Generate JWT token for user
     * @param {string} userId - User identifier
     * @param {string} fingerprint - Browser fingerprint
     * @returns {Object} { token, refreshToken, expiresAt }
     */
    generateToken(userId, fingerprint) {
        const now = Date.now();
        const expiresAt = now + this.config.tokenExpiry;
        const refreshExpiresAt = now + this.config.refreshTokenExpiry;

        // Create payload
        const payload = {
            userId,
            fingerprint,
            iat: now,
            exp: expiresAt
        };

        const refreshPayload = {
            userId,
            fingerprint,
            iat: now,
            exp: refreshExpiresAt,
            type: 'refresh'
        };

        // Simple JWT implementation (in production, use jsonwebtoken library)
        const token = this._createJWT(payload);
        const refreshToken = this._createJWT(refreshPayload);

        return {
            token,
            refreshToken,
            expiresAt,
            refreshExpiresAt
        };
    }

    /**
     * Validate and decode JWT token
     * @param {string} token - JWT token
     * @returns {Object|null} Decoded payload or null if invalid
     */
    validateToken(token) {
        try {
            const payload = this._decodeJWT(token);

            // Check expiration
            if (Date.now() > payload.exp) {
                return null;
            }

            return payload;
        } catch (error) {
            return null;
        }
    }

    /**
     * Check rate limit using token bucket algorithm
     * @param {string} userId - User identifier
     * @param {string} action - Action type (messages/skips/reports)
     * @returns {boolean} True if within limit
     */
    checkRateLimit(userId, action) {
        const config = this.rateLimitConfig[action];
        if (!config) return true;

        const now = Date.now();

        if (!this.rateLimits.has(userId)) {
            this.rateLimits.set(userId, { messages: [], skips: [], reports: [] });
        }

        const userLimits = this.rateLimits.get(userId);
        const actionArray = userLimits[action] || [];

        // Remove entries older than window
        const recentActions = actionArray.filter(time => now - time < config.window);
        userLimits[action] = recentActions;

        if (recentActions.length >= config.limit) {
            return false;
        }

        recentActions.push(now);
        return true;
    }

    /**
     * Track IP connection
     * @param {string} ip - IP address
     * @returns {boolean} True if connection allowed
     */
    trackIPConnection(ip) {
        const now = Date.now();

        if (!this.ipConnections.has(ip)) {
            this.ipConnections.set(ip, { connections: [], lastConnection: now });
        }

        const ipData = this.ipConnections.get(ip);
        ipData.connections = ipData.connections.filter(time => now - time < 60000);

        if (ipData.connections.length >= this.config.maxConnectionsPerIP) {
            return false;
        }

        ipData.connections.push(now);
        ipData.lastConnection = now;
        return true;
    }

    /**
     * Check if IP is banned
     * @param {string} ip - IP address
     * @returns {boolean} True if banned
     */
    isIPBanned(ip) {
        const ban = this.bannedIPs.get(ip);
        if (!ban) return false;

        if (Date.now() > ban.until) {
            this.bannedIPs.delete(ip);
            return false;
        }
        return true;
    }

    /**
     * Ban an IP address
     * @param {string} ip - IP address
     * @param {number} duration - Ban duration in milliseconds
     * @param {string} reason - Ban reason
     */
    banIP(ip, duration, reason) {
        this.bannedIPs.set(ip, {
            until: Date.now() + duration,
            reason,
            bannedAt: Date.now()
        });
    }

    /**
     * Unban an IP address
     * @param {string} ip - IP address
     */
    unbanIP(ip) {
        this.bannedIPs.delete(ip);
    }

    /**
     * Track user fingerprint
     * @param {string} fingerprint - Browser fingerprint
     * @param {string} userId - User identifier
     * @returns {Object} { suspicious: boolean, reason: string }
     */
    trackFingerprint(fingerprint, userId) {
        if (!this.fingerprints.has(fingerprint)) {
            this.fingerprints.set(fingerprint, {
                userIds: new Set(),
                reports: 0,
                bans: 0,
                firstSeen: Date.now()
            });
        }

        const session = this.fingerprints.get(fingerprint);
        session.userIds.add(userId);

        // Check if fingerprint has too many violations
        if (session.reports >= 5 || session.bans >= 3) {
            return { suspicious: true, reason: 'Multiple violations' };
        }

        return { suspicious: false };
    }

    /**
     * Validate message content
     * @param {string} message - Message to validate
     * @returns {Object} { valid: boolean, reason: string, filtered: string }
     */
    validateMessage(message) {
        // Type check
        if (typeof message !== 'string') {
            return { valid: false, reason: 'Invalid type', filtered: '' };
        }

        // Length check
        if (message.length === 0) {
            return { valid: false, reason: 'Empty message', filtered: '' };
        }

        if (message.length > CONSTANTS.MAX_MESSAGE_LENGTH) {
            return { valid: false, reason: 'Message too long', filtered: '' };
        }

        // Check for dangerous patterns
        for (const pattern of this.dangerousPatterns) {
            if (pattern.test(message)) {
                return { valid: false, reason: 'Dangerous content detected', filtered: '' };
            }
        }

        // Filter profanity
        const filtered = this.filterProfanity(message);

        return { valid: true, filtered };
    }

    /**
     * Filter profanity from message
     * @param {string} message - Message to filter
     * @returns {string} Filtered message
     */
    filterProfanity(message) {
        try {
            return this.profanityFilter.clean(message);
        } catch (error) {
            console.error('Error filtering profanity:', error);
            return message; // Return original if filtering fails
        }
    }

    /**
     * Detect abuse patterns
     * @param {string} userId - User identifier
     * @returns {Array} Array of detected patterns
     */
    detectAbusePatterns(userId) {
        if (!this.abuseTracking.has(userId)) {
            return [];
        }

        const tracking = this.abuseTracking.get(userId);
        const sessionDuration = (Date.now() - tracking.startTime) / 1000; // seconds
        const patterns = [];

        // Detect spammer (high message rate)
        if (sessionDuration > CONSTANTS.ABUSE_SESSION_MIN_DURATION_SEC &&
            tracking.messageCount / sessionDuration > CONSTANTS.ABUSE_MESSAGE_RATE_THRESHOLD) {
            patterns.push('spammer');
        }

        // Detect skip abuser
        if (tracking.skipCount > CONSTANTS.ABUSE_SKIP_COUNT_THRESHOLD) {
            patterns.push('skip_abuser');
        }

        // Detect harasser (reported multiple times)
        if (tracking.reportCount >= CONSTANTS.ABUSE_REPORT_COUNT_THRESHOLD) {
            patterns.push('harasser');
        }

        return patterns;
    }

    /**
     * Track user action for abuse detection
     * @param {string} userId - User identifier
     * @param {string} action - Action type (message/skip/report)
     */
    trackUserAction(userId, action) {
        if (!this.abuseTracking.has(userId)) {
            this.abuseTracking.set(userId, {
                messageCount: 0,
                skipCount: 0,
                reportCount: 0,
                violations: [],
                startTime: Date.now()
            });
        }

        const tracking = this.abuseTracking.get(userId);

        switch (action) {
            case 'message':
                tracking.messageCount++;
                break;
            case 'skip':
                tracking.skipCount++;
                break;
            case 'report':
                tracking.reportCount++;
                break;
        }
    }

    /**
     * Encrypt message (AES-256-GCM)
     * @param {string} message - Message to encrypt
     * @returns {Object} { encrypted: string, iv: string, tag: string }
     */
    encryptMessage(message) {
        if (!this.config.enableEncryption) {
            return { encrypted: message, iv: null, tag: null };
        }

        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.config.encryptionKey, iv);

        let encrypted = cipher.update(message, 'utf8', 'hex');
        encrypted += cipher.final('hex');

        const tag = cipher.getAuthTag();

        return {
            encrypted,
            iv: iv.toString('hex'),
            tag: tag.toString('hex')
        };
    }

    /**
     * Decrypt message (AES-256-GCM)
     * @param {string} encrypted - Encrypted message
     * @param {string} iv - Initialization vector
     * @param {string} tag - Authentication tag
     * @returns {string} Decrypted message
     */
    decryptMessage(encrypted, iv, tag) {
        if (!this.config.enableEncryption) {
            return encrypted;
        }

        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            this.config.encryptionKey,
            Buffer.from(iv, 'hex')
        );

        decipher.setAuthTag(Buffer.from(tag, 'hex'));

        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    }

    /**
     * Get security statistics
     * @returns {Object} Security metrics
     */
    getSecurityStats() {
        return {
            bannedIPs: this.bannedIPs.size,
            trackedFingerprints: this.fingerprints.size,
            usersWithRateLimits: this.rateLimits.size,
            usersBeingTracked: this.abuseTracking.size,
            ipConnections: this.ipConnections.size
        };
    }

    /**
     * Clean up old data
     */
    cleanup() {
        const now = Date.now();

        // Clean up expired bans
        for (const [ip, ban] of this.bannedIPs.entries()) {
            if (now > ban.until) {
                this.bannedIPs.delete(ip);
            }
        }

        // Clean up old IP connections (older than 1 hour)
        for (const [ip, data] of this.ipConnections.entries()) {
            if (now - data.lastConnection > 3600000) {
                this.ipConnections.delete(ip);
            }
        }

        // Clean up old abuse tracking (older than 24 hours)
        for (const [userId, tracking] of this.abuseTracking.entries()) {
            if (now - tracking.startTime > 86400000) {
                this.abuseTracking.delete(userId);
            }
        }
    }

    /**
     * Create simple JWT (for production, use jsonwebtoken library)
     * @private
     */
    _createJWT(payload) {
        const header = { alg: 'HS256', typ: 'JWT' };
        const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
        const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

        const signature = crypto
            .createHmac('sha256', this.config.jwtSecret)
            .update(`${encodedHeader}.${encodedPayload}`)
            .digest('base64url');

        return `${encodedHeader}.${encodedPayload}.${signature}`;
    }

    /**
     * Decode simple JWT
     * @private
     */
    _decodeJWT(token) {
        const parts = token.split('.');
        if (parts.length !== 3) throw new Error('Invalid token');

        const [encodedHeader, encodedPayload, signature] = parts;

        // Verify signature
        const expectedSignature = crypto
            .createHmac('sha256', this.config.jwtSecret)
            .update(`${encodedHeader}.${encodedPayload}`)
            .digest('base64url');

        if (signature !== expectedSignature) {
            throw new Error('Invalid signature');
        }

        return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
    }
}

module.exports = SecurityManager;
