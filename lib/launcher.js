// lib/launcher.js — Antigravity process launcher & killer
// Manages launching Antigravity with CDP flags and killing all instances

const { execFile, exec } = require('child_process');
const net = require('net');
const path = require('path');
const cdp = require('./cdp');

/** Check if a TCP port is listening */
function isPortOpen(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(1000);
        socket.on('connect', () => { socket.destroy(); resolve(true); });
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
        socket.on('error', () => { socket.destroy(); resolve(false); });
        socket.connect(port, host);
    });
}

/** Launch Antigravity with remote debugging enabled */
async function launch(config) {
    const antigravityPath = config.antigravityPath;
    if (!antigravityPath) {
        return { success: false, error: 'antigravityPath not set in config.json' };
    }

    const cdpPort = config.cdpPorts?.[0] || 9000;

    // Check if already running with CDP
    const portOpen = await isPortOpen(cdpPort);
    if (portOpen) {
        // Already running — try to discover
        const targets = await cdp.discover([cdpPort]);
        if (targets.length > 0) {
            return { success: true, message: 'Antigravity already running with CDP', alreadyRunning: true };
        }
        return { success: false, error: 'RESTART_REQUIRED', message: 'Port in use but no Antigravity targets found' };
    }

    // Build launch command based on OS and path
    const args = [`--remote-debugging-port=${cdpPort}`];

    return new Promise((resolve) => {
        try {
            const child = execFile(antigravityPath, args, {
                detached: true,
                stdio: 'ignore',
                windowsHide: false
            });

            child.unref(); // Don't keep our process alive for Antigravity

            child.on('error', (err) => {
                resolve({ success: false, error: err.message });
            });

            // Wait for CDP port to become available
            let attempts = 0;
            const maxAttempts = 30; // 30 * 1s = 30s max

            const checkInterval = setInterval(async () => {
                attempts++;
                const open = await isPortOpen(cdpPort);

                if (open) {
                    clearInterval(checkInterval);
                    resolve({ success: true, message: `Antigravity launched, CDP on port ${cdpPort}` });
                } else if (attempts >= maxAttempts) {
                    clearInterval(checkInterval);
                    resolve({ success: false, error: 'Timeout waiting for CDP port' });
                }
            }, 1000);

        } catch (err) {
            resolve({ success: false, error: err.message });
        }
    });
}

/** Kill all Antigravity processes */
async function killAll() {
    // First, close all CDP connections gracefully
    const closedConnections = cdp.disconnectAll();

    // Then kill OS processes
    return new Promise((resolve) => {
        const isWindows = process.platform === 'win32';

        const cmd = isWindows
            ? 'taskkill /F /IM Antigravity.exe /IM windsurf.exe /IM cursor.exe 2>nul'
            : 'pkill -f "Antigravity|windsurf|cursor" 2>/dev/null || true';

        exec(cmd, (err) => {
            resolve({
                success: true,
                closedConnections,
                message: err ? 'Kill command completed (some processes may not have been found)' : 'All processes killed'
            });
        });
    });
}

/** Express route handlers */
function routes(config) {
    return {
        launch: async (req, res) => {
            try {
                const result = await launch(config);
                res.json(result);
            } catch (err) {
                res.status(500).json({ success: false, error: err.message });
            }
        },
        killAll: async (req, res) => {
            try {
                const result = await killAll();
                res.json(result);
            } catch (err) {
                res.status(500).json({ success: false, error: err.message });
            }
        }
    };
}

module.exports = { launch, killAll, isPortOpen, routes };
