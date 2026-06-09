/**
 * NAF Pilot E-Flight Log Book System — Service Worker
 * Version: 1.0.0
 *
 * Strategy:
 *  - App shell (HTML) → Network-first, fallback to cache
 *  - CDN libraries (Chart.js, jsPDF, SheetJS, dayjs, QRCode) → Cache-first (stable versions)
 *  - Firebase SDK → Network-only (requires live auth/Firestore)
 *  - Everything else → Network-first with cache fallback
 */

const CACHE_NAME    = 'pilot-elogbook-v1';
const CDN_CACHE     = 'pilot-elogbook-cdn-v1';
const OFFLINE_PAGE  = './pilot_eflightlog_pwa.html';

// App shell — always try to keep fresh
const APP_SHELL = [
  './pilot_eflightlog_pwa.html',
  './manifest.json',
];

// CDN libraries that don't change — cache aggressively
const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/dayjs/1.11.10/dayjs.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
];

// Firebase domains — always network-only (auth + Firestore require live connection)
const NETWORK_ONLY_DOMAINS = [
  'firestore.googleapis.com',
  'firebase.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebasestorage.googleapis.com',
];

// ─── INSTALL ────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing NAF E-Logbook Service Worker…');
  event.waitUntil(
    Promise.all([
      // Cache app shell
      caches.open(CACHE_NAME).then(cache => {
        console.log('[SW] Caching app shell');
        return cache.addAll(APP_SHELL).catch(err => {
          console.warn('[SW] App shell cache partial failure:', err);
        });
      }),
      // Cache CDN libraries
      caches.open(CDN_CACHE).then(cache => {
        console.log('[SW] Caching CDN libraries');
        return Promise.allSettled(
          CDN_ASSETS.map(url =>
            cache.add(url).catch(err =>
              console.warn('[SW] CDN cache miss for', url, err)
            )
          )
        );
      }),
    ]).then(() => {
      console.log('[SW] Install complete — skipWaiting');
      return self.skipWaiting(); // Activate immediately
    })
  );
});

// ─── ACTIVATE ───────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating…');
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key !== CACHE_NAME && key !== CDN_CACHE)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      );
    }).then(() => {
      console.log('[SW] Activated — claiming clients');
      return self.clients.claim(); // Take control of all open tabs immediately
    })
  );
});

// ─── FETCH ──────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Firebase / Google APIs — always network-only, no cache
  if (NETWORK_ONLY_DOMAINS.some(domain => url.hostname.includes(domain))) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 2. Firebase gstatic SDK — network-only (auth modules)
  if (url.hostname === 'www.gstatic.com' && url.pathname.includes('firebasejs')) {
    event.respondWith(networkOnlyWithFallback(event.request));
    return;
  }

  // 3. CDN libraries (Chart.js, jsPDF, etc.) — cache-first (stable versions)
  if (CDN_ASSETS.includes(event.request.url) || url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith(cacheFirst(event.request, CDN_CACHE));
    return;
  }

  // 4. App shell HTML — network-first, fallback to cache
  if (event.request.mode === 'navigate' || event.request.url.endsWith('.html')) {
    event.respondWith(networkFirstWithCache(event.request, CACHE_NAME));
    return;
  }

  // 5. Manifest and other local assets — cache-first
  if (event.request.url.includes('manifest.json') || event.request.url.includes('icon-')) {
    event.respondWith(cacheFirst(event.request, CACHE_NAME));
    return;
  }

  // 6. Default — network-first with cache fallback
  event.respondWith(networkFirstWithCache(event.request, CACHE_NAME));
});

// ─── STRATEGIES ─────────────────────────────────────────────────────────────

/**
 * Cache-first: serve from cache if available, else fetch and cache.
 * Best for: versioned CDN libraries that never change.
 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    console.warn('[SW] cacheFirst fetch failed, no cache:', request.url, err);
    return new Response('Resource unavailable offline', { status: 503 });
  }
}

/**
 * Network-first: try network, update cache, fallback to cache on failure.
 * Best for: app shell HTML that should stay fresh.
 */
async function networkFirstWithCache(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) {
      console.log('[SW] Network failed, serving from cache:', request.url);
      return cached;
    }
    // Last resort: serve the main app shell (handles deep links offline)
    const fallback = await cache.match(OFFLINE_PAGE);
    if (fallback) return fallback;
    return new Response(offlinePage(), {
      headers: { 'Content-Type': 'text/html' },
    });
  }
}

/**
 * Network-only with fallback error response.
 * Best for: Firebase SDK (must be online).
 */
async function networkOnlyWithFallback(request) {
  try {
    return await fetch(request);
  } catch (err) {
    return new Response('Network required for this resource', { status: 503 });
  }
}

// ─── OFFLINE FALLBACK PAGE ───────────────────────────────────────────────────
function offlinePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#003366">
<title>115 SOG Pilot E-Logbook — Offline</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',system-ui,sans-serif;background:#0A192F;color:#E8EDF5;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:1.5rem}
  .card{background:#0F2035;border:1px solid #1E3A5F;border-radius:16px;padding:2.5rem;max-width:380px;width:100%}
  .icon{font-size:4rem;margin-bottom:1rem}
  h1{font-size:1.2rem;font-weight:800;color:#D4AF37;letter-spacing:2px;margin-bottom:.5rem}
  p{font-size:.85rem;color:#94A3B8;line-height:1.6;margin-bottom:1.25rem}
  .btn{display:inline-block;background:#D4AF37;color:#0A192F;padding:.7rem 1.5rem;border-radius:8px;font-weight:700;font-size:.875rem;cursor:pointer;border:none;text-decoration:none}
  .btn:hover{background:#B8942E}
  .note{font-size:.75rem;color:#64748B;margin-top:1rem}
</style>
</head>
<body>
  <div class="card">
    <div class="icon">✈</div>
    <h1>NAF E-LOGBOOK</h1>
    <p>You are currently offline. The app requires an internet connection to sync with Firebase.<br><br>Please reconnect and try again.</p>
    <button class="btn" onclick="window.location.reload()">↻ Retry</button>
    <div class="note">NIGERIAN AIR FORCE — OFFICIAL AVIATION SYSTEM</div>
  </div>
</body>
</html>`;
}

// ─── BACKGROUND SYNC (future: queue offline flight entries) ─────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-flights') {
    console.log('[SW] Background sync: sync-flights');
    // Future: dequeue IndexedDB pending entries and push to Firestore
  }
});

// ─── PUSH NOTIFICATIONS (future: medical expiry reminders) ──────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'NAF E-Logbook', {
      body: data.body || '',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: data.tag || 'naf-notification',
      data: { url: data.url || './' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data?.url || './')
  );
});

// ─── MESSAGE HANDLER (receive SKIP_WAITING from update banner) ──────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] SKIP_WAITING received — activating new version');
    self.skipWaiting();
  }
});

console.log('[SW] NAF E-Logbook Service Worker loaded — v1.0.0');
