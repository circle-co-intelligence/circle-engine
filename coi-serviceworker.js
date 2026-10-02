/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed MIT
 *  Adds COOP/COEP via a service worker for hosts that can't set headers
 *  (e.g. GitHub Pages), restoring crossOriginIsolated / SharedArrayBuffer. */
if (typeof window === 'undefined') {
	self.addEventListener('install', () => self.skipWaiting());
	self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

	self.addEventListener('fetch', (e) => {
		const r = e.request;
		if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
		e.respondWith(
			fetch(r)
				.then((res) => {
					if (res.status === 0) return res;
					const headers = new Headers(res.headers);
					headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
					headers.set('Cross-Origin-Opener-Policy', 'same-origin');
					return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
				})
				.catch((err) => console.error(err))
		);
	});
} else {
	(() => {
		const reloadedBySW = sessionStorage.getItem('coi-reloaded') === '1';
		if (window.crossOriginIsolated) return;
		if (!('serviceWorker' in navigator)) return;

		// register at its own URL → scope = the deploy base (works under /repo/)
		const src = document.currentScript?.src ?? new URL('coi-serviceworker.js', document.baseURI).href;
		navigator.serviceWorker
			.register(src)
			.then((reg) => {
				reg.addEventListener('updatefound', () => {
					const w = reg.installing;
					w?.addEventListener('statechange', () => {
						if (w.state === 'activated' && !reloadedBySW) {
							sessionStorage.setItem('coi-reloaded', '1');
							location.reload();
						}
					});
				});
				if (reg.active && !navigator.serviceWorker.controller && !reloadedBySW) {
					sessionStorage.setItem('coi-reloaded', '1');
					location.reload();
				}
			})
			.catch((e) => console.error('[coi] registration failed', e));
	})();
}
