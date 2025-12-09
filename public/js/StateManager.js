/**
 * StateManager - Client-Side State Management
 * 
 * Features:
 * - Reactive state updates with observers
 * - State persistence to localStorage
 * - State history for undo/redo
 * - Computed properties
 * - State validation
 */

class StateManager {
    constructor() {
        // Application state
        this.state = {
            // Connection state
            connected: false,
            connectionStatus: 'disconnected',
            userId: null,
            fingerprint: null,

            // Current view
            currentView: 'landing', // landing, text, video
            currentMode: null, // text, video, voice

            // Partner info
            partnerId: null,
            partnerConnected: false,

            // Chat state
            messages: [],
            typing: false,

            // User preferences
            isMuted: false,

            // UI state
            isLoading: false,
            error: null,

            // Metrics
            userCount: 0,
            queuePosition: null
        };

        // State observers
        this.observers = new Map();

        // State history (for undo/redo)
        this.history = [];
        this.historyIndex = -1;
        this.maxHistory = 50;

        // Load persisted state
        this.loadPersistedState();
    }

    /**
     * Get state value
     * @param {string} key - State key
     * @returns {*} State value
     */
    get(key) {
        return this.state[key];
    }

    /**
     * Set state value and notify observers
     * @param {string} key - State key
     * @param {*} value - New value
     * @param {boolean} persist - Whether to persist to localStorage
     */
    set(key, value, persist = false) {
        const oldValue = this.state[key];

        // Check if value actually changed
        if (oldValue === value) return;

        // Update state
        this.state[key] = value;

        // Add to history
        this.addToHistory(key, oldValue, value);

        // Persist if requested
        if (persist) {
            this.persistState(key, value);
        }

        // Notify observers
        this.notifyObservers(key, value, oldValue);
    }

    /**
     * Set multiple state values at once
     * @param {Object} updates - Object with key-value pairs
     */
    setMultiple(updates) {
        for (const [key, value] of Object.entries(updates)) {
            this.set(key, value);
        }
    }

    /**
     * Subscribe to state changes
     * @param {string} key - State key to observe
     * @param {Function} callback - Callback function
     * @returns {Function} Unsubscribe function
     */
    subscribe(key, callback) {
        if (!this.observers.has(key)) {
            this.observers.set(key, new Set());
        }

        this.observers.get(key).add(callback);

        // Return unsubscribe function
        return () => {
            this.observers.get(key)?.delete(callback);
        };
    }

    /**
     * Notify observers of state change
     * @private
     */
    notifyObservers(key, newValue, oldValue) {
        const observers = this.observers.get(key);
        if (observers) {
            observers.forEach(callback => {
                try {
                    callback(newValue, oldValue);
                } catch (error) {
                    console.error(`Error in state observer for ${key}:`, error);
                }
            });
        }

        // Also notify wildcard observers (*)
        const wildcardObservers = this.observers.get('*');
        if (wildcardObservers) {
            wildcardObservers.forEach(callback => {
                try {
                    callback(key, newValue, oldValue);
                } catch (error) {
                    console.error('Error in wildcard state observer:', error);
                }
            });
        }
    }

    /**
     * Add state change to history
     * @private
     */
    addToHistory(key, oldValue, newValue) {
        // Remove any history after current index
        this.history = this.history.slice(0, this.historyIndex + 1);

        // Add new entry
        this.history.push({
            key,
            oldValue,
            newValue,
            timestamp: Date.now()
        });

        // Limit history size
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        } else {
            this.historyIndex++;
        }
    }

    /**
     * Undo last state change
     * @returns {boolean} True if undo was performed
     */
    undo() {
        if (this.historyIndex < 0) return false;

        const entry = this.history[this.historyIndex];
        this.state[entry.key] = entry.oldValue;
        this.notifyObservers(entry.key, entry.oldValue, entry.newValue);
        this.historyIndex--;

        return true;
    }

    /**
     * Redo last undone state change
     * @returns {boolean} True if redo was performed
     */
    redo() {
        if (this.historyIndex >= this.history.length - 1) return false;

        this.historyIndex++;
        const entry = this.history[this.historyIndex];
        this.state[entry.key] = entry.newValue;
        this.notifyObservers(entry.key, entry.newValue, entry.oldValue);

        return true;
    }

    /**
     * Persist state to localStorage
     * @private
     */
    persistState(key, value) {
        try {
            const persistKey = `vibeconnect_${key}`;
            localStorage.setItem(persistKey, JSON.stringify(value));
        } catch (error) {
            console.error(`Error persisting state for ${key}:`, error);
        }
    }

    /**
     * Load persisted state from localStorage
     * @private
     */
    loadPersistedState() {
        const persistedKeys = ['isMuted', 'userId', 'fingerprint'];

        for (const key of persistedKeys) {
            try {
                const persistKey = `vibeconnect_${key}`;
                const value = localStorage.getItem(persistKey);
                if (value !== null) {
                    this.state[key] = JSON.parse(value);
                }
            } catch (error) {
                console.error(`Error loading persisted state for ${key}:`, error);
            }
        }
    }

    /**
     * Clear persisted state
     */
    clearPersistedState() {
        const keys = Object.keys(this.state);
        for (const key of keys) {
            try {
                localStorage.removeItem(`vibeconnect_${key}`);
            } catch (error) {
                console.error(`Error clearing persisted state for ${key}:`, error);
            }
        }
    }

    /**
     * Reset state to initial values
     */
    reset() {
        this.state = {
            connected: false,
            connectionStatus: 'disconnected',
            userId: this.state.userId, // Keep userId
            fingerprint: this.state.fingerprint, // Keep fingerprint
            currentView: 'landing',
            currentMode: null,
            partnerId: null,
            partnerConnected: false,
            messages: [],
            typing: false,
            isMuted: this.state.isMuted, // Keep mute preference
            isLoading: false,
            error: null,
            userCount: 0,
            queuePosition: null
        };

        // Notify all observers
        this.notifyObservers('*', this.state, {});
    }

    /**
     * Get entire state (for debugging)
     * @returns {Object} Current state
     */
    getState() {
        return { ...this.state };
    }

    /**
     * Computed property: Is user in a chat
     * @returns {boolean}
     */
    isInChat() {
        return this.state.partnerId !== null && this.state.partnerConnected;
    }

    /**
     * Computed property: Can send messages
     * @returns {boolean}
     */
    canSendMessages() {
        return this.isInChat() && this.state.connected;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = StateManager;
}
