// server.js — Antigravity-GO
// Real-time mobile command center for Antigravity IDE via Chrome DevTools Protocol
//
// Architecture:
//   Express serves the frontend + REST API
//   ws WebSocket pushes live snapshots to connected browsers
//   lib/ modules handle CDP, snapshot capture, auth, push notifications, and process management

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

// ─── Module imports ───
const cdp = require('./lib/cdp');
const snapshot = require('./lib/snapshot');
const auth = require('./lib/auth');
const push = require('./lib/push');
const launcher = require('./lib/launcher');

// ─── Configuration ───
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config;

try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
    // No config.json — copy from example and use defaults
    const examplePath = path.join(__dirname, 'config.example.json');
    if (fs.existsSync(examplePath)) {
        fs.copyFileSync(examplePath, CONFIG_PATH);
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        console.log('[Server] Created config.json from example — edit it to customize');
    } else {
        config = { port: 6969, password: '', cdpPorts: [9000, 9001, 9002, 9003], snapshotIntervalMs: 2000 };
        console.log('[Server] Using default configuration');
    }
}

const PORT = config.port || 6969;

// ─── Express setup ───
const app = express();
const server = http.createServer(app);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Auth middleware (skips if no password set)
app.use(auth.authMiddleware(config));

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    dotfiles: 'deny'
}));

// ─── REST API Routes ───

// Auth
app.post('/api/login', auth.loginHandler(config));
app.get('/api/logout', auth.logoutHandler());
app.get('/api/auth-status', (req, res) => {
    res.json({ authEnabled: !!config.password, authenticated: true });
});

// Snapshot on demand (for initial page load before WS connects)
app.get('/snapshot', async (req, res) => {
    try {
        const conn = getActiveConnection();
        if (!conn) return res.json({ html: '', css: '', connected: false });

        const [html, css, quota, meta] = await Promise.all([
            snapshot.captureHTML(conn),
            snapshot.captureCSS(conn),
            snapshot.extractQuota(conn),
            snapshot.extractMetadata(conn)
        ]);

        res.json({
            html: html?.html || '',
            bodyBg: html?.bodyBg || '#1a1a1a',
            clickMap: html?.clickMap || {},
            css: css || '',
            quota: quota || null,
            title: meta?.title || 'Antigravity',
            connected: true
        });
    } catch (err) {
        res.json({ html: '', css: '', connected: false, error: err.message });
    }
});

// CSS (for auto-refreshing styles via link tag)
app.get('/styles/antigravity.css', async (req, res) => {
    try {
        const conn = getActiveConnection();
        if (!conn) return res.type('css').send('/* not connected */');

        const css = await snapshot.captureCSS(conn);
        res.type('css').set('Cache-Control', 'no-store').send(css || '/* empty */');
    } catch (err) {
        res.type('css').send('/* error */');
    }
});

// DOM discovery (debug tool to find the right chat selector)
app.get('/api/discover', async (req, res) => {
    try {
        const conn = getActiveConnection();
        if (!conn) return res.status(503).json({ error: 'No CDP connection' });

        const discovery = await snapshot.discoverDOM(conn);
        res.json(discovery);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List all CDP targets (debug tool)
app.get('/api/targets', async (req, res) => {
    try {
        const targets = await cdp.discover(config.cdpPorts || [9000, 9001, 9002, 9003]);
        res.json(targets);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Click relay
app.post('/click/:index', async (req, res) => {
    try {
        const conn = getActiveConnection();
        if (!conn) return res.status(503).json({ error: 'No CDP connection' });

        const result = await snapshot.clickElement(conn, parseInt(req.params.index));
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Send message
app.post('/send', async (req, res) => {
    try {
        const conn = getActiveConnection();
        if (!conn) return res.status(503).json({ error: 'No CDP connection' });

        const { text } = req.body;
        if (!text) return res.status(400).json({ error: 'No text provided' });

        const result = await snapshot.injectMessage(conn, text);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// New conversation
app.post('/api/new-chat', async (req, res) => {
    try {
        const conn = getActiveConnection();
        if (!conn) return res.status(503).json({ error: 'No CDP connection' });

        const result = await snapshot.newConversation(conn);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Push notification routes
const pushRoutes = push.routes(config);
app.post('/api/push/subscribe', pushRoutes.subscribe);
app.post('/api/push/unsubscribe', pushRoutes.unsubscribe);
app.get('/api/push/vapid-key', pushRoutes.vapidKey);

// Launcher routes
const launcherRoutes = launcher.routes(config);
app.post('/api/launch', launcherRoutes.launch);
app.post('/api/kill', launcherRoutes.killAll);

// CDP status
app.get('/api/status', async (req, res) => {
    const connections = cdp.getConnections();
    const targets = [];

    for (const [id, conn] of connections) {
        targets.push({ id, title: conn.title, port: conn.port, active: conn.active });
    }

    res.json({
        connected: targets.length > 0,
        targets,
        config: {
            port: PORT,
            authEnabled: !!config.password,
            cdpPorts: config.cdpPorts
        }
    });
});

// Account Manager proxy (if configured)
app.get('/api/manager/cascades', async (req, res) => {
    if (!config.managerUrl) return res.status(404).json({ error: 'Manager not configured' });

    try {
        const url = `${config.managerUrl}/cascades`;
        const headers = {};
        if (config.managerPassword) {
            headers['Authorization'] = `Bearer ${config.managerPassword}`;
        }

        const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Manager unreachable', details: err.message });
    }
});

// ─── WebSocket server ───
const wss = new WebSocket.Server({ noServer: true });

// Handle upgrade with auth check
server.on('upgrade', (req, socket, head) => {
    if (!auth.verifyWsAuth(req, config)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
    });
});

// Client connections
wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log(`[WS] Client connected from ${ip}`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', console.error);

    ws.on('message', async (raw) => {
        try {
            const msg = JSON.parse(raw.toString());

            switch (msg.type) {
                case 'click':
                    if (msg.index != null) {
                        const conn = getActiveConnection();
                        if (conn) await snapshot.clickElement(conn, msg.index);
                    }
                    break;

                case 'send':
                    if (msg.text) {
                        const conn = getActiveConnection();
                        if (conn) await snapshot.injectMessage(conn, msg.text);
                    }
                    break;

                case 'new-chat':
                    const conn = getActiveConnection();
                    if (conn) await snapshot.newConversation(conn);
                    break;
            }
        } catch (err) {
            console.error('[WS] Message handling error:', err.message);
        }
    });

    ws.on('close', () => {
        console.log(`[WS] Client disconnected from ${ip}`);
    });

    // Send initial status
    ws.send(JSON.stringify({
        type: 'status',
        connected: cdp.getConnections().size > 0,
        authEnabled: !!config.password
    }));
});

// Heartbeat ping/pong (30s interval, per ws best practices)
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

// ─── CDP Auto-Discovery & Snapshot Loop ───
let snapshotInterval = null;
let discoveryInterval = null;
let lastCSSHash = '';

/** Get best CDP connection — prefers main workbench (which contains the cascade iframe) */
function getActiveConnection() {
    const connections = cdp.getConnections();
    let fallback = null;

    for (const [, conn] of connections) {
        if (!conn.active || conn.ws?.readyState !== WebSocket.OPEN) continue;

        // Prefer the main workbench — the cascade chat lives in an iframe inside it
        const title = (conn.title || '').toLowerCase();
        if (title.includes('antigravity') || title.includes('walkthrough')) {
            return conn;
        }

        if (!fallback) fallback = conn;
    }

    return fallback;
}

/** Broadcast data to all WS clients */
function wsBroadcast(data) {
    const payload = JSON.stringify(data);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

/** Discovery loop: find and connect to Antigravity CDP targets */
async function discoveryLoop() {
    try {
        const targets = await cdp.discover(config.cdpPorts || [9000, 9001, 9002, 9003]);

        for (const target of targets) {
            if (!cdp.getConnections().has(target.id)) {
                try {
                    await cdp.connect(target);
                    console.log(`[CDP] Connected to: ${target.title} (port ${target.port})`);
                    wsBroadcast({ type: 'status', connected: true, title: target.title });
                } catch (err) {
                    console.warn(`[CDP] Failed to connect to ${target.title}:`, err.message);
                }
            }
        }

        // Notify if no connections
        if (cdp.getConnections().size === 0) {
            wsBroadcast({ type: 'status', connected: false });
        }
    } catch (err) {
        // Discovery loop shouldn't crash the server
    }
}

/** Snapshot loop: capture and broadcast at regular intervals */
async function snapshotLoop() {
    const conn = getActiveConnection();
    if (!conn) return;

    // Skip if no WS clients are watching
    if (wss.clients.size === 0) return;

    try {
        // Scroll desktop chat to bottom so virtualized list renders latest content
        // (progress updates, tool calls, streaming text won't appear otherwise)
        await snapshot.scrollChatToBottom(conn).catch(() => { });

        const [htmlData, cssData, quotaData] = await Promise.all([
            snapshot.captureHTML(conn).catch(() => null),
            snapshot.captureCSS(conn).catch(() => null),
            snapshot.extractQuota(conn).catch(() => null)
        ]);

        if (!htmlData) return;


        // Only send CSS if it changed (to save bandwidth)
        let cssPayload = null;
        const cssHash = simpleHash(cssData || '');
        if (cssHash !== lastCSSHash) {
            cssPayload = cssData;
            lastCSSHash = cssHash;
        }

        // Broadcast to all connected browsers
        wsBroadcast({
            type: 'snapshot',
            html: htmlData.html || '',
            bodyBg: htmlData.bodyBg || '#1a1a1a',
            clickMap: htmlData.clickMap || {},
            css: cssPayload,
            quota: quotaData
        });

        // Check for AI completion (for push notifications)
        push.checkAICompletion('main', htmlData.html);

    } catch (err) {
        // Individual snapshot failure shouldn't stop the loop
        if (err.message?.includes('closed') || err.message?.includes('not open')) {
            wsBroadcast({ type: 'status', connected: false });
        }
    }
}

/** Simple hash for CSS change detection */
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return hash.toString(36);
}

// ─── Start everything ───
push.init(config, CONFIG_PATH);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║   🚀 Antigravity-GO v1.0                ║`);
    console.log(`║   http://localhost:${PORT}                  ║`);
    console.log(`║   Auth: ${config.password ? 'ENABLED (password set)' : 'DISABLED (no password)'}    ║`);
    console.log(`║   CDP Ports: ${(config.cdpPorts || [9000]).join(', ')}          ║`);
    console.log(`╚══════════════════════════════════════════╝\n`);

    // Start discovery loop (every 5 seconds)
    discoveryLoop();
    discoveryInterval = setInterval(discoveryLoop, 5000);

    // Start snapshot loop
    const interval = config.snapshotIntervalMs || 2000;
    snapshotInterval = setInterval(snapshotLoop, interval);
    console.log(`[Server] Snapshot interval: ${interval}ms`);
});

// Graceful shutdown
function shutdown() {
    console.log('\n[Server] Shutting down...');
    clearInterval(snapshotInterval);
    clearInterval(discoveryInterval);
    clearInterval(heartbeatInterval);
    cdp.disconnectAll();
    wss.close();
    server.close();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server };
