// Service worker: receives push notifications while the app is closed and opens the app when one is tapped.
// It does not cache anything — the app always loads fresh from the server.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { body: event.data ? event.data.text() : '' } }
  event.waitUntil(self.registration.showNotification(data.title || 'Printeri', {
    body: data.body || '',
    tag: data.tag || undefined, // same tag = replaces the earlier notification about the same thing
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      // The app is already open: bring it forward and go to the right page.
      if ('focus' in client) {
        if ('navigate' in client) { try { await client.navigate(url) } catch { /* cross-origin or not controlled */ } }
        return client.focus()
      }
    }
    return self.clients.openWindow(url)
  })())
})
