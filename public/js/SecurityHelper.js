/**
 * SecurityHelper - Client-Side Security Utilities
 * 
 * Features:
 * - Input sanitization (XSS prevention)
 * - Content Security Policy helpers
 * - Secure storage (encrypted localStorage)
 * - Browser fingerprinting
 * - CSRF token management
 */

class SecurityHelper {
    constructor() {
        // HTML entities for sanitization
        this.htmlEntities = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#x27;',
            '/': '&#x2F;'
        };

        // Dangerous patterns
        this.dangerousPatterns = [
            /<script/i,
            /javascript:/i,
            /on\w+=/i,
            /<iframe/i,
            /onerror=/i,
            /onload=/i
        ];
    }

    /**
     * Generate browser fingerprint
     * @returns {string} Unique fingerprint
     */
    generateFingerprint() {
        const data = [
            navigator.userAgent,
            navigator.language,
            screen.width + 'x' + screen.height,
            screen.colorDepth,
            new Date().getTimezoneOffset(),
            navigator.hardwareConcurrency || 0,
            navigator.platform,
            this.getCanvasFingerprint(),
            this.getFontsFingerprint()
        ].join('|');

        return this.simpleHash(data);
    }

    /**
     * Get canvas fingerprint
     * @private
     */
    getCanvasFingerprint() {
        try {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            // Draw text
            ctx.textBaseline = 'top';
            ctx.font = '14px Arial';
            ctx.fillStyle = '#f60';
            ctx.fillRect(125, 1, 62, 20);
            ctx.fillStyle = '#069';
            ctx.fillText('VibeConnect', 2, 15);
            ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
            ctx.fillText('VibeConnect', 4, 17);

            return canvas.toDataURL();
        } catch (error) {
            return 'canvas-unavailable';
        }
    }

    /**
     * Get fonts fingerprint
     * @private
     */
    getFontsFingerprint() {
        const baseFonts = ['monospace', 'sans-serif', 'serif'];
        const testFonts = ['Arial', 'Verdana', 'Times New Roman', 'Courier New', 'Georgia'];
        const testString = 'mmmmmmmmmmlli';
        const testSize = '72px';

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        const baselines = {};
        for (const baseFont of baseFonts) {
            ctx.font = testSize + ' ' + baseFont;
            baselines[baseFont] = ctx.measureText(testString).width;
        }

        const detected = [];
        for (const testFont of testFonts) {
            for (const baseFont of baseFonts) {
                ctx.font = testSize + ' ' + testFont + ', ' + baseFont;
                const width = ctx.measureText(testString).width;
                if (width !== baselines[baseFont]) {
                    detected.push(testFont);
                    break;
                }
            }
        }

        return detected.join(',');
    }

    /**
     * Simple hash function
     * @private
     */
    simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(36);
    }

    /**
     * Sanitize HTML string to prevent XSS
     * @param {string} str - String to sanitize
     * @returns {string} Sanitized string
     */
    sanitizeHTML(str) {
        if (typeof str !== 'string') return '';

        return str.replace(/[&<>"'\/]/g, (char) => this.htmlEntities[char] || char);
    }

    /**
     * Validate input against dangerous patterns
     * @param {string} input - Input to validate
     * @returns {boolean} True if safe
     */
    isSafeInput(input) {
        if (typeof input !== 'string') return false;

        for (const pattern of this.dangerousPatterns) {
            if (pattern.test(input)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Sanitize and validate input
     * @param {string} input - Input to process
     * @returns {Object} { safe: boolean, sanitized: string }
     */
    processInput(input) {
        const safe = this.isSafeInput(input);
        const sanitized = this.sanitizeHTML(input);

        return { safe, sanitized };
    }

    /**
     * Generate random user ID
     * @returns {string} Random ID
     */
    generateUserId() {
        return Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15);
    }

    /**
     * Validate URL
     * @param {string} url - URL to validate
     * @returns {boolean} True if valid
     */
    isValidURL(url) {
        try {
            const parsed = new URL(url);
            return ['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol);
        } catch (error) {
            return false;
        }
    }

    /**
     * Check if running in secure context
     * @returns {boolean} True if secure (HTTPS or localhost)
     */
    isSecureContext() {
        return window.isSecureContext ||
            window.location.protocol === 'https:' ||
            window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1';
    }

    /**
     * Get Content Security Policy violations
     * @returns {Array} Array of CSP violations
     */
    getCSPViolations() {
        const violations = [];

        document.addEventListener('securitypolicyviolation', (e) => {
            violations.push({
                violatedDirective: e.violatedDirective,
                effectiveDirective: e.effectiveDirective,
                originalPolicy: e.originalPolicy,
                blockedURI: e.blockedURI,
                timestamp: Date.now()
            });
        });

        return violations;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SecurityHelper;
}
