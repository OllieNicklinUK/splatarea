/* coi-serviceworker — cross-origin isolation via service worker for GitHub Pages */
(function () {
  if (typeof window === 'undefined') {
    // ── Running as the service worker ───────────────────────────────────────
    self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', (event) => {
      if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;
      event.respondWith(
        fetch(event.request).then((response) => {
          if (response.status === 0) return response;
          const headers = new Headers(response.headers);
          headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
          headers.set('Cross-Origin-Opener-Policy', 'same-origin');
          headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }).catch(() => fetch(event.request))
      );
    });
    return;
  }

  // ── Running in page context — register the service worker ────────────────
  if (window.crossOriginIsolated) return;
  if (!('serviceWorker' in navigator)) {
    console.warn('[coi-sw] Service workers not supported — SharedArrayBuffer may be unavailable');
    return;
  }

  const swSrc = document.currentScript && document.currentScript.src;
  if (!swSrc) return;

  navigator.serviceWorker.register(swSrc).then((reg) => {
    if (navigator.serviceWorker.controller) return; // already controlling — just wait for next navigation
    const sw = reg.installing || reg.waiting;
    if (!sw) { location.reload(); return; }
    sw.addEventListener('statechange', () => {
      if (sw.state === 'activated') location.reload();
    });
  }).catch((e) => console.warn('[coi-sw] Registration failed:', e));
})();
