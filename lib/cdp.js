// lib/cdp.js — Chrome DevTools Protocol connection management
// Handles discovery, connection, reconnection, and CDP command execution

const WebSocket = require('ws');
const http = require('http');

/** Active CDP connections: Map<windowId, { ws, url, contextId, contexts, title, active }> */
const connections = new Map();

/** Discover debuggable targets across CDP ports */
async function discover(ports = [9000, 9001, 9002, 9003]) {
  const targets = [];

  for (const port of ports) {
    try {
      const data = await httpGet(`http://127.0.0.1:${port}/json`);
      const pages = JSON.parse(data);

      for (const page of pages) {
        if (page.type !== 'page' || !page.webSocketDebuggerUrl) continue;

        // Filter for Antigravity windows — look for relevant titles/URLs
        const title = (page.title || '').toLowerCase();
        const url = (page.url || '').toLowerCase();
        const isAntigravity = title.includes('antigravity') ||
          title.includes('windsurf') ||
          title.includes('cursor') ||
          title.includes('jetski') ||
          title.includes('launchpad') ||
          url.includes('workbench');

        if (isAntigravity) {
          targets.push({
            id: page.id,
            title: page.title,
            wsUrl: page.webSocketDebuggerUrl,
            port
          });
        }
      }
    } catch (_) {
      // Port not listening — skip silently
    }
  }

  return targets;
}

/** Connect to a CDP target via WebSocket */
async function connect(target) {
  return new Promise((resolve, reject) => {
    if (connections.has(target.id)) {
      return resolve(connections.get(target.id));
    }

    const ws = new WebSocket(target.wsUrl, { perMessageDeflate: false });
    let cmdId = 1;
    const pending = new Map();
    const conn = {
      ws,
      url: target.wsUrl,
      title: target.title,
      port: target.port,
      mainFrameId: target.id, // The page's frame ID — child iframes will have different frameIds
      contextId: null,
      // Track ALL execution contexts (main frame + iframes)
      contexts: new Map(),
      active: true,
      _cmdId: () => cmdId++,
      _pending: pending
    };

    ws.on('open', async () => {
      connections.set(target.id, conn);

      // Enable Runtime to get execution contexts
      await sendCommand(conn, 'Runtime.enable');

      // Wait for execution contexts — Antigravity takes a moment
      setTimeout(() => resolve(conn), 1200);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Track ALL execution contexts
        if (msg.method === 'Runtime.executionContextCreated') {
          const ctx = msg.params?.context;
          if (ctx) {
            const frameId = ctx.auxData?.frameId || 'unknown';
            conn.contexts.set(ctx.id, {
              id: ctx.id,
              frameId,
              name: ctx.name || '',
              origin: ctx.origin || '',
              isDefault: !!ctx.auxData?.isDefault
            });

            // Set default context for the main frame
            if (ctx.auxData?.isDefault && !conn.contextId) {
              conn.contextId = ctx.id;
            }
          }
        }

        // Remove destroyed contexts
        if (msg.method === 'Runtime.executionContextDestroyed') {
          const ctxId = msg.params?.executionContextId;
          if (ctxId) conn.contexts.delete(ctxId);
          if (conn.contextId === ctxId) conn.contextId = null;
        }

        if (msg.method === 'Runtime.executionContextsCleared') {
          conn.contexts.clear();
          conn.contextId = null;
        }

        // Resolve pending commands
        if (msg.id && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      } catch (_) { }
    });

    ws.on('close', () => {
      conn.active = false;
      connections.delete(target.id);
      pending.forEach(({ reject }) => reject(new Error('CDP connection closed')));
      pending.clear();
    });

    ws.on('error', (err) => {
      if (!connections.has(target.id)) reject(err);
    });

    // Timeout after 10s
    setTimeout(() => {
      if (!connections.has(target.id)) {
        ws.terminate();
        reject(new Error('CDP connection timeout'));
      }
    }, 10000);
  });
}

/** Send a CDP command and await the result */
function sendCommand(conn, method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('CDP WebSocket not open'));
    }

    const id = conn._cmdId();
    const timeout = setTimeout(() => {
      conn._pending.delete(id);
      reject(new Error(`CDP command timed out: ${method}`));
    }, 15000);

    conn._pending.set(id, {
      resolve: (result) => { clearTimeout(timeout); resolve(result); },
      reject: (err) => { clearTimeout(timeout); reject(err); }
    });

    conn.ws.send(JSON.stringify({ id, method, params }));
  });
}

/**
 * Find the execution context ID for the cascade/chat iframe.
 * Returns the context ID for the cascade-panel iframe, or falls back to the main context.
 */
function findChatContextId(conn) {
  // Find the execution context for a child iframe (cascade-panel)
  // Child iframes have a different frameId than the main page (conn.mainFrameId)
  for (const [ctxId, ctx] of conn.contexts) {
    if (ctx.isDefault && ctx.frameId && ctx.frameId !== conn.mainFrameId && ctx.frameId !== 'unknown') {
      return ctxId;
    }
  }
  // Fallback to default context
  return conn.contextId;
}

/** Execute JavaScript in the page context via Runtime.evaluate */
async function evaluate(conn, expression, opts = {}) {
  // Use the chat iframe context if available, unless explicitly told to use main
  const contextId = opts.useMainContext
    ? conn.contextId
    : (opts.contextId || findChatContextId(conn) || conn.contextId);

  const params = {
    expression,
    returnByValue: true,
    awaitPromise: true,
    silent: true,
    timeout: opts.timeout || 10000,
    objectGroup: 'aggo',
    disableBreaks: true,
    allowUnsafeEvalBlockedByCSP: true
  };

  if (contextId) {
    params.contextId = contextId;
  }

  const result = await sendCommand(conn, 'Runtime.evaluate', params);

  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime.evaluate exception');
  }

  return result?.result?.value;
}

/** Disconnect a specific CDP connection */
function disconnect(targetId) {
  const conn = connections.get(targetId);
  if (conn?.ws) {
    try { conn.ws.close(); } catch (_) { }
  }
  connections.delete(targetId);
}

/** Disconnect all CDP connections */
function disconnectAll() {
  let count = 0;
  for (const [id, conn] of connections) {
    try { conn.ws.close(); } catch (_) { }
    count++;
  }
  connections.clear();
  return count;
}

/** Get all active connections */
function getConnections() {
  return connections;
}

/** Simple HTTP GET helper */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject)
      .on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

module.exports = { discover, connect, sendCommand, evaluate, disconnect, disconnectAll, getConnections, findChatContextId };
