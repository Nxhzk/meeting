// Retire the old workspace service worker without touching recording drafts
// (IndexedDB) or an unrelated app's Cache Storage on this domain.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        await self.clients.claim();
        await self.registration.unregister();
    })());
});
