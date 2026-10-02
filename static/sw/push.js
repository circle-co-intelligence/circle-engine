/* cic push SW — receives empty-payload VAPID rings from cic-push and opens the
   circle. The room URL is posted by the page on join (and cached) so the
   notification deep-links without the push service ever seeing a payload. */
self.addEventListener('push', (e) => {
	e.waitUntil(
		(async () => {
			let url = self.__roomUrl;
			if (!url) {
				try {
					const c = await caches.open('cic-push');
					const res = await c.match('/last-room');
					if (res) url = await res.text();
				} catch {}
			}
			await self.registration.showNotification('Co-Intelligence Circle', {
				body: 'A circle is waiting — tap to join',
				icon: '/brand/symbol-light.png',
				badge: '/brand/symbol-light.png',
				data: { url: url ?? '/' }
			});
		})()
	);
});

self.addEventListener('notificationclick', (e) => {
	e.notification.close();
	e.waitUntil(
		(async () => {
			const url = e.notification.data?.url ?? '/';
			const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
			const existing = all.find((c) => c.url === url);
			if (existing) return existing.focus();
			return clients.openWindow(url);
		})()
	);
});

self.addEventListener('message', (e) => {
	if (e.data?.roomUrl) {
		self.__roomUrl = e.data.roomUrl;
		caches.open('cic-push').then((c) => c.put('/last-room', new Response(e.data.roomUrl))).catch(() => {});
	}
});
