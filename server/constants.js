/**
 * Server-Side Constants and Configuration
 * 
 * Centralizes all magic numbers and configuration values
 */

module.exports = {
    // Message Limits
    MAX_MESSAGE_SIZE: 10240, // 10KB
    MAX_MESSAGE_LENGTH: 500,

    // Timeouts
    SKIP_DELAY_MS: 300,
    REPORT_DISCONNECT_DELAY_MS: 1500,
    MODE_SWITCH_DELAY_MS: 500,
    MODE_SWITCH_ACCEPT_DELAY_MS: 1000,
    WEBRTC_CONNECTION_TIMEOUT_MS: 15000,

    // Cleanup Intervals
    CLEANUP_INTERVAL_MS: 60000, // 1 minute

    // Security
    MIN_JWT_SECRET_LENGTH: 32,

    // WebSocket Close Codes
    WS_CLOSE_NORMAL: 1000,
    WS_CLOSE_GOING_AWAY: 1001,
    WS_CLOSE_PROTOCOL_ERROR: 1002,

    // HTTP Status Codes
    HTTP_FORBIDDEN: 403,
    HTTP_TOO_MANY_REQUESTS: 429,

    // Retry Configuration
    MAX_RETRY_ATTEMPTS: 3,
    RETRY_BASE_DELAY_MS: 100,

    // Queue Configuration
    DEFAULT_QUEUE_TIMEOUT: 300000, // 5 minutes
    DEFAULT_MAX_QUEUE_SIZE: 10000,

    // Connection Configuration
    DEFAULT_HEARTBEAT_INTERVAL: 30000, // 30 seconds
    DEFAULT_CONNECTION_TIMEOUT: 60000, // 1 minute

    // Rate Limiting Defaults
    DEFAULT_RATE_LIMIT_MESSAGES: 30,
    DEFAULT_RATE_LIMIT_WINDOW_MS: 60000,
    DEFAULT_RATE_LIMIT_SKIPS: 10,
    DEFAULT_RATE_LIMIT_REPORTS: 3,
    DEFAULT_RATE_LIMIT_REPORTS_WINDOW_MS: 3600000, // 1 hour

    // Ban Configuration
    DEFAULT_BAN_DURATION: 86400000, // 24 hours

    // Abuse Detection Thresholds
    ABUSE_MESSAGE_RATE_THRESHOLD: 2, // messages per second
    ABUSE_SKIP_COUNT_THRESHOLD: 15,
    ABUSE_REPORT_COUNT_THRESHOLD: 3,
    ABUSE_SESSION_MIN_DURATION_SEC: 10
};

// Validate constants
function validateConstants() {
    const errors = [];

    if (module.exports.MAX_MESSAGE_SIZE <= 0) {
        errors.push('MAX_MESSAGE_SIZE must be positive');
    }

    if (module.exports.MAX_MESSAGE_LENGTH <= 0) {
        errors.push('MAX_MESSAGE_LENGTH must be positive');
    }

    if (module.exports.MIN_JWT_SECRET_LENGTH < 16) {
        errors.push('MIN_JWT_SECRET_LENGTH should be at least 16');
    }

    if (module.exports.DEFAULT_QUEUE_TIMEOUT < 1000) {
        errors.push('DEFAULT_QUEUE_TIMEOUT should be at least 1 second');
    }

    if (errors.length > 0) {
        throw new Error(`Invalid constants configuration:\n${errors.join('\n')}`);
    }
}

// Run validation
validateConstants();
