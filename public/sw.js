const CACHE_NAME = 'flownotes-v2'
const SUPABASE_HOST = 'qkgwudhlwxkvalqaoetl.supabase.co'

// Take over immediately so a new version replaces the old one without waiting.
self.addEventListener('install', () => {
  self.skipWaiting()
})

// On activate: delete every cache except the current one (purges stale bundles).
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  // Never cache Supabase API calls.
  if (url.hostname === SUPABASE_HOST) {
    event.respondWith(fetch(event.request).catch(() => new Response('', { status: 503 })))
    return
  }

  // Only handle same-origin GETs; let everything else pass through untouched.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return

  // Network-first: always try the network so app code updates are picked up
  // right away. Fall back to the cache only when the network is unavailable
  // (offline support). This is the opposite of the old cache-first strategy,
  // which froze the app on whatever bundle was cached first.
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
        }
        return response
      })
      .catch(() => caches.match(event.request))
  )
})
