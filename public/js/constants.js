/**
 * Client-Side Constants
 * 
 * Centralizes all magic numbers and configuration values
 */

const CONSTANTS = {
    // Timeouts
    SKIP_DELAY_MS: 300,
    TYPING_TIMEOUT_MS: 2000,
    ERROR_MESSAGE_DISPLAY_MS: 3000,
    VIDEO_REQUEST_CANCEL_DELAY_MS: 500,
    MODE_SWITCH_DELAY_MS: 500,
    MODE_SWITCH_ACCEPT_DELAY_MS: 1000,
    PARTNER_MISMATCH_DELAY_MS: 2000,

    // WebRTC
    WEBRTC_CONNECTION_TIMEOUT_MS: 15000,

    // WebSocket Reconnection
    WS_RECONNECT_DELAY_MS: 1000,
    WS_MAX_RECONNECT_DELAY_MS: 30000,
    WS_RECONNECT_DECAY: 1.5,
    WS_HEARTBEAT_INTERVAL_MS: 30000,
    WS_MESSAGE_TIMEOUT_MS: 5000,

    // Audio
    NOTIFICATION_FREQUENCY_HZ: 800,
    NOTIFICATION_DURATION_SEC: 0.5,
    NOTIFICATION_GAIN: 0.3,

    // UI
    MESSAGE_CONTAINER_HEIGHT_PX: 350,
    VIDEO_HEIGHT_PX: 300,

    // State Management
    MAX_HISTORY_SIZE: 50,

    // Message Queue
    MAX_MESSAGE_QUEUE_SIZE: 100,

    // WebSocket URLs
    WS_PRODUCTION_URL: 'wss://vibeconnect-4crg.onrender.com/',
    WS_LOCAL_URL: 'ws://localhost:3000'
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CONSTANTS;
}
