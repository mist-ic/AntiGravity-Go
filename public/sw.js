// sw.js — Service Worker for Antigravity-GO PWA
// Handles caching for offline access and push notification display

const CACHE_NAME = 'aggo-v2';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/login.html',
    '/manifest.json'
];

// ─── Install: Pre-cache static assets ───
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// ─── Activate: Clean old caches ───
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// ─── Fetch: Network-first with cache fallback ───
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests and API/WebSocket requests
    if (event.request.method !== 'GET') return;
    if (url.pathname.startsWith('/api/')) return;
    if (url.pathname.startsWith('/snapshot')) return;
    if (url.pathname.startsWith('/styles/')) return;
    if (url.pathname.startsWith('/click/')) return;
    if (url.pathname.startsWith('/send')) return;

    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Cache successful responses for static assets
                if (response.ok && STATIC_ASSETS.includes(url.pathname)) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => {
                // Offline fallback
                return caches.match(event.request);
            })
    );
});

// ─── Push Notification Handler ───
self.addEventListener('push', (event) => {
    let data = { title: 'AG Chat', body: 'New notification' };

    try {
        if (event.data) {
            data = { ...data, ...event.data.json() };
        }
    } catch (_) {
        if (event.data) {
            data.body = event.data.text();
        }
    }

    const options = {
        body: data.body,
        icon: '/icons/icon-192.svg',
        badge: '/icons/icon-192.svg',
        vibrate: [100, 50, 100],
        tag: 'aggo-notification',      // Replace previous notification
        renotify: true,
        data: {
            url: self.registration.scope,
            ...data
        },
        actions: [
            { action: 'open', title: 'Open Chat' },
            { action: 'dismiss', title: 'Dismiss' }
        ]
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

// ─── Notification Click Handler ───
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    if (event.action === 'dismiss') return;

    // Focus existing window or open new one
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then(windowClients => {
                // Focus existing tab if found
                for (const client of windowClients) {
                    if (client.url.includes(self.registration.scope)) {
                        return client.focus();
                    }
                }
                // Open new tab
                return clients.openWindow(self.registration.scope);
            })
    );
});
