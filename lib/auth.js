// lib/auth.js — Optional password authentication via signed cookies
// Only active when config.password is set. Zero extra dependencies.

const crypto = require('crypto');

const COOKIE_NAME = 'aggo_auth';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Derive a signing key from the password (deterministic, no salt needed for HMAC) */
function signingKey(password) {
    return crypto.createHash('sha256').update(password).digest();
}

/** Create a signed auth token: HMAC-SHA256(timestamp:password_hash) */
function createToken(password) {
    const timestamp = Date.now().toString(36);
    const key = signingKey(password);
    const signature = crypto.createHmac('sha256', key).update(timestamp).digest('hex');
    return `${timestamp}.${signature}`;
}

/** Verify a signed token is valid and was created with the correct password */
function verifyToken(token, password) {
    if (!token || !password) return false;

    const parts = token.split('.');
    if (parts.length !== 2) return false;

    const [timestamp, signature] = parts;
    const key = signingKey(password);
    const expected = crypto.createHmac('sha256', key).update(timestamp).digest('hex');

    // Timing-safe comparison to prevent timing attacks
    if (signature.length !== expected.length) return false;

    try {
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch (_) {
        return false;
    }
}

/** Express middleware factory: skips auth if no password configured */
function authMiddleware(config) {
    return (req, res, next) => {
        // No password = auth disabled, let everything through
        if (!config.password) return next();

        // Allow login page and static assets without auth
        const publicPaths = ['/login.html', '/api/login', '/manifest.json', '/sw.js', '/icons/'];
        if (publicPaths.some(p => req.path.startsWith(p))) return next();

        // Check auth cookie
        const cookies = parseCookies(req.headers.cookie);
        const token = cookies[COOKIE_NAME];

        if (verifyToken(token, config.password)) {
            return next();
        }

        // API requests get 401, page requests redirect to login
        if (req.path.startsWith('/api/') || req.path.startsWith('/snapshot/') ||
            req.path.startsWith('/styles/') || req.path.startsWith('/send/') ||
            req.path.startsWith('/click/') || req.path.startsWith('/cascades')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        return res.redirect('/login.html');
    };
}

/** Login route handler */
function loginHandler(config) {
    return (req, res) => {
        const { password } = req.body || {};

        if (!password || password !== config.password) {
            return res.status(401).json({ error: 'Wrong password' });
        }

        const token = createToken(config.password);

        res.cookie(COOKIE_NAME, token, {
            httpOnly: true,
            sameSite: 'strict',
            maxAge: COOKIE_MAX_AGE,
            secure: false  // Allow HTTP for local network use
        });

        return res.json({ success: true });
    };
}

/** Logout route handler */
function logoutHandler() {
    return (req, res) => {
        res.clearCookie(COOKIE_NAME);
        res.redirect('/login.html');
    };
}

/** Verify WebSocket upgrade request has valid auth */
function verifyWsAuth(req, config) {
    if (!config.password) return true;
    const cookies = parseCookies(req.headers.cookie);
    return verifyToken(cookies[COOKIE_NAME], config.password);
}

/** Simple cookie parser (avoids cookie-parser dependency) */
function parseCookies(header) {
    const cookies = {};
    if (!header) return cookies;

    header.split(';').forEach(pair => {
        const [key, ...val] = pair.trim().split('=');
        if (key) cookies[key.trim()] = decodeURIComponent(val.join('='));
    });

    return cookies;
}

module.exports = { authMiddleware, loginHandler, logoutHandler, verifyWsAuth, createToken, verifyToken };
