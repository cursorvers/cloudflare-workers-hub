/**
 * Service Worker for PWA Push Notifications
 * Handles push events and displays native browser notifications
 */

const SW_VERSION = '1.0.0';
const CACHE_NAME = `cockpit-pwa-${SW_VERSION}`;

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log(`[SW ${SW_VERSION}] Installing...`);

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log(`[SW ${SW_VERSION}] Cache opened`);
      // Add critical assets to cache here if needed
      return cache.addAll([
        '/',
        // Add other static assets as needed
      ]);
    }).then(() => {
      // Force activation immediately
      return self.skipWaiting();
    })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log(`[SW ${SW_VERSION}] Activating...`);

  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log(`[SW ${SW_VERSION}] Deleting old cache: ${cacheName}`);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // Take control of all clients immediately
      return self.clients.claim();
    })
  );
});

// Push event - display notification
self.addEventListener('push', (event) => {
  console.log(`[SW ${SW_VERSION}] Push received`);

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
      const payload = event.data.json();
      console.log(`[SW ${SW_VERSION}] Push payload:`, payload);

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

      // Add action buttons based on severity
      if (payload.actionUrl) {
        notificationData.actions = [
          { action: 'open', title: 'Open' },
          { action: 'dismiss', title: 'Dismiss' },
        ];
      }
    } catch (error) {
      console.error(`[SW ${SW_VERSION}] Failed to parse push payload:`, error);
    }
  }

  event.waitUntil(
    self.registration.showNotification(notificationData.title, notificationData)
  );
});

// Notification click event
self.addEventListener('notificationclick', (event) => {
  console.log(`[SW ${SW_VERSION}] Notification clicked:`, event.notification.tag);

  event.notification.close();

  const notificationData = event.notification.data || {};
  const actionUrl = notificationData.actionUrl;

  // Handle action buttons
  if (event.action === 'dismiss') {
    return;
  }

  // Open or focus the app
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Try to focus existing window
      for (const client of clientList) {
        if (client.url.includes('/cockpit') && 'focus' in client) {
          return client.focus().then((focusedClient) => {
            // Navigate to action URL if provided
            if (actionUrl && focusedClient.navigate) {
              return focusedClient.navigate(actionUrl);
            }
            return focusedClient;
          });
        }
      }

      // Open new window if no existing window found
      if (clients.openWindow) {
        const targetUrl = actionUrl || '/cockpit';
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// Fetch event - network-first strategy for API calls
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip cross-origin requests
  if (url.origin !== location.origin) {
    return;
  }

  // API requests - network first
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Cache successful GET responses
          if (event.request.method === 'GET' && response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Fallback to cache on network error
          return caches.match(event.request);
        })
    );
    return;
  }

  // Static assets - cache first
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request).then((response) => {
        // Cache successful responses
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      });
    })
  );
});

// Message event - handle commands from clients
self.addEventListener('message', (event) => {
  console.log(`[SW ${SW_VERSION}] Message received:`, event.data);

  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: SW_VERSION });
  }
});

console.log(`[SW ${SW_VERSION}] Service Worker loaded`);
