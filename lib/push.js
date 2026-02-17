// lib/push.js — Web Push notification system
// Manages VAPID keys, subscriptions, and AI-completion detection

const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

let subscriptions = [];            // Active push subscriptions
let isInitialized = false;

// AI completion detection state (per cascade)
const detectionState = new Map();  // cascadeId -> { lastHtml, stableCount, lastNotifyTime }
const STABILITY_CHECKS = 3;       // Number of consecutive identical snapshots = "done" (3 * interval ≈ 6-9s)
const NOTIFY_COOLDOWN = 120000;   // 2 minute cooldown between notifications for same cascade

/** Initialize web-push with VAPID keys from config */
function init(config, configPath) {
    if (!config.vapidSubject) {
        config.vapidSubject = 'mailto:aggo@example.com';
    }

    // Auto-generate VAPID keys if not set
    if (!config.vapidPublicKey || !config.vapidPrivateKey) {
        console.log('[Push] Generating new VAPID keys...');
        const keys = webpush.generateVAPIDKeys();
        config.vapidPublicKey = keys.publicKey;
        config.vapidPrivateKey = keys.privateKey;

        // Persist to config file
        try {
            const configFile = configPath || path.join(process.cwd(), 'config.json');
            if (fs.existsSync(configFile)) {
                const existing = JSON.parse(fs.readFileSync(configFile, 'utf8'));
                existing.vapidPublicKey = keys.publicKey;
                existing.vapidPrivateKey = keys.privateKey;
                fs.writeFileSync(configFile, JSON.stringify(existing, null, 2));
                console.log('[Push] VAPID keys saved to config.json');
            }
        } catch (err) {
            console.warn('[Push] Could not save VAPID keys to config:', err.message);
        }
    }

    try {
        webpush.setVapidDetails(
            config.vapidSubject,
            config.vapidPublicKey,
            config.vapidPrivateKey
        );
        isInitialized = true;
        console.log('[Push] Web push initialized');
    } catch (err) {
        console.error('[Push] Failed to initialize:', err.message);
    }
}

/** Subscribe a new push endpoint */
function subscribe(subscription) {
    if (!subscription?.endpoint) return false;

    // Dedupe by endpoint
    const exists = subscriptions.some(s => s.endpoint === subscription.endpoint);
    if (!exists) {
        subscriptions.push(subscription);
        console.log(`[Push] New subscription (${subscriptions.length} total)`);
    }
    return true;
}

/** Unsubscribe by endpoint */
function unsubscribe(endpoint) {
    const before = subscriptions.length;
    subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
    console.log(`[Push] Unsubscribed (${before} -> ${subscriptions.length})`);
    return true;
}

/** Get the public VAPID key for client-side subscription */
function getPublicKey(config) {
    return config.vapidPublicKey || null;
}

/** Send a push notification to all subscribers */
async function broadcast(title, body, data = {}) {
    if (!isInitialized || subscriptions.length === 0) return;

    const payload = JSON.stringify({
        title,
        body,
        ...data
    });

    const options = {
        TTL: 3600,           // 1 hour time-to-live
        urgency: 'normal',
        topic: 'ai-response' // Replaces previous unread notification of same topic
    };

    const stale = [];

    await Promise.allSettled(
        subscriptions.map(async (sub) => {
            try {
                await webpush.sendNotification(sub, payload, options);
            } catch (err) {
                if (err.statusCode === 410 || err.statusCode === 404) {
                    // Subscription expired — mark for removal
                    stale.push(sub.endpoint);
                } else if (err.statusCode === 429) {
                    // Rate limited by Chrome (Jan 2026+) — log but don't remove
                    console.warn('[Push] Rate limited (429), will retry later');
                } else {
                    console.error('[Push] Send error:', err.statusCode || err.message);
                    stale.push(sub.endpoint);
                }
            }
        })
    );

    // Clean up stale subscriptions
    if (stale.length > 0) {
        subscriptions = subscriptions.filter(s => !stale.includes(s.endpoint));
        console.log(`[Push] Removed ${stale.length} stale subscriptions`);
    }
}

/**
 * Check if the AI has finished responding by detecting content stability.
 * Call this each snapshot cycle with the current HTML.
 * Returns true when the content stops changing (AI done).
 */
function checkAICompletion(cascadeId, currentHtml) {
    if (subscriptions.length === 0) return; // No subscribers, skip detection

    let state = detectionState.get(cascadeId);
    if (!state) {
        state = { lastHtml: '', stableCount: 0, lastNotifyTime: 0, wasChanging: false };
        detectionState.set(cascadeId, state);
    }

    const htmlSignature = simpleHash(currentHtml || '');

    if (htmlSignature !== state.lastHtml) {
        // Content changed — reset stability counter, mark as "changing"
        state.lastHtml = htmlSignature;
        state.stableCount = 0;
        state.wasChanging = true;
    } else if (state.wasChanging) {
        // Content same as last check — increment stability
        state.stableCount++;

        if (state.stableCount >= STABILITY_CHECKS) {
            const now = Date.now();
            if (now - state.lastNotifyTime > NOTIFY_COOLDOWN) {
                state.lastNotifyTime = now;
                state.wasChanging = false;

                // Fire notification
                broadcast('💬 AI Response Complete', 'The AI has finished responding', {
                    cascadeId
                });
            }
        }
    }
}

/** Simple fast hash for content comparison (not crypto — just dedup) */
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32-bit integer
    }
    return hash.toString(36);
}

/** Get route handlers for Express */
function routes(config) {
    return {
        subscribe: (req, res) => {
            const result = subscribe(req.body);
            res.json({ success: result });
        },
        unsubscribe: (req, res) => {
            const { endpoint } = req.body || {};
            unsubscribe(endpoint);
            res.json({ success: true });
        },
        vapidKey: (req, res) => {
            const key = getPublicKey(config);
            if (key) res.json({ publicKey: key });
            else res.status(500).json({ error: 'Push not configured' });
        }
    };
}

module.exports = { init, subscribe, unsubscribe, getPublicKey, broadcast, checkAICompletion, routes };
