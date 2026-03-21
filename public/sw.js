// Immediately unregister this service worker — socket.io is incompatible with SW caching
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(self.registration.unregister());
});
