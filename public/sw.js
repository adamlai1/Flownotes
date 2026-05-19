const CACHE_NAME = 'flownotes-v1'
const SUPABASE_HOST = 'qkgwudhlwxkvalqaoetl.supabase.co'

// On install: cache the app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(['/', '/index.html'])
    )
  )
  self.skipWaiting()
})

// On activate: remove old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  // Network-first for Supabase API calls
  if (url.hostname === SUPABASE_HOST) {
    event.respondWith(
      fetch(event.request).catch(() => new Response('', { status: 503 }))
    )
    return
  }

  // Cache-first for everything else (app shell, assets)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached
      return fetch(event.request).then(response => {
        // Cache successful GET responses for static assets
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
        }
        return response
      })
    })
  )
})
