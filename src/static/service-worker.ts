const SERVICE_WORKER_CODE = `
// Service Worker for PWA Push Notifications (Phase 2)
const SW_VERSION = '1.0.0';
const CACHE_NAME = 'cockpit-pwa-' + SW_VERSION;

self.addEventListener('install', (event) => {
  console.log('[SW ' + SW_VERSION + '] Installing...');
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  console.log('[SW ' + SW_VERSION + '] Activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('push', (event) => {
  console.log('[SW] Push received');
  let notificationData = {
    title: 'Cockpit Alert',
    body: 'New notification',
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    tag: 'cockpit-alert',
    requireInteraction: false,
  };

  if (event.data) {
    try {
      const text = event.data.text();
      if (!text || text.trim().length === 0) {
        console.warn('[SW] Push data is empty, using default notification');
      } else {
        const payload = JSON.parse(text);
        console.log('[SW] Push payload:', payload);
        notificationData = {
          title: payload.title || notificationData.title,
          body: payload.message || payload.body || notificationData.body,
          icon: payload.icon || notificationData.icon,
          badge: payload.badge || notificationData.badge,
          tag: payload.id || payload.tag || notificationData.tag,
          data: {
            id: payload.id,
            severity: payload.severity,
            source: payload.source,
            actionUrl: payload.actionUrl,
            timestamp: payload.createdAt || Date.now(),
          },
          requireInteraction: payload.severity === 'critical' || payload.severity === 'error',
        };
        if (payload.actionUrl) {
          notificationData.actions = [
            { action: 'open', title: 'Open' },
            { action: 'dismiss', title: 'Dismiss' },
          ];
        }
      }
    } catch (error) {
      console.error('[SW] Failed to parse push payload:', error);
      console.log('[SW] Using default notification data');
    }
  }

  event.waitUntil(
    self.registration.showNotification(notificationData.title, notificationData)
  );
});

self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event.notification.tag);
  event.notification.close();

  const notificationData = event.notification.data || {};
  const actionUrl = notificationData.actionUrl;

  if (event.action === 'dismiss') {
    return;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/cockpit') && 'focus' in client) {
          return client.focus().then((focusedClient) => {
            if (actionUrl && focusedClient.navigate) {
              return focusedClient.navigate(actionUrl);
            }
            return focusedClient;
          });
        }
      }
      if (clients.openWindow) {
        const targetUrl = actionUrl || '/cockpit';
        return clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener('message', (event) => {
  console.log('[SW] Message received:', event.data);
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: SW_VERSION });
  }
});

console.log('[SW ' + SW_VERSION + '] Service Worker loaded');
`.trim();

export function handleServiceWorker(): Response {
  return new Response(SERVICE_WORKER_CODE, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Service-Worker-Allowed': '/',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}
