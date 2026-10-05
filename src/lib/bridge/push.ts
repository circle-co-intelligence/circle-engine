/**
 * Room push — "ring a friend into the circle" via the cic-push worker
 * (proxied same-origin at /api/push/*). Real mechanics:
 *
 *   initRoomPush(code) — registers sw/push.js; if the user already granted
 *     notifications (prod's own settings toggle calls requestPermission —
 *     we patch it once and subscribe on grant), a PushManager subscription
 *     is stored under the room CODE at the broker. The room secret stays in
 *     the URL fragment — the broker never sees it.
 *   ringRoom(code) — an entering member pings that code's subscribers once
 *     per RING_COOLDOWN (client-side rate limit; empty payload pushes).
 */
import { base } from '$app/paths';

import { base64url } from '@scure/base';
const RING_COOLDOWN_MS = 5 * 60 * 1000;
let patched = false;
let activeCode = '';
let activeUrl = '';

const enabled = () =>
	typeof navigator !== 'undefined' &&
	'serviceWorker' in navigator &&
	'PushManager' in window &&
	typeof Notification !== 'undefined';

// the broker only exists where Pages Functions do — probe once, cache the
// answer, and let every caller no-op quietly on static hosts
let available: Promise<boolean> | null = null;
function brokerUp(): Promise<boolean> {
	return (available ??= fetch(`${base}/api/push/vapid`, { signal: AbortSignal.timeout(2500) })
		.then((r) => r.ok)
		.catch(() => false));
}

const b64ToBytes = (b: string) => base64url.decode(b) as Uint8Array<ArrayBuffer>;

async function subscribe(code: string, roomUrl: string): Promise<void> {
	try {
		if (!(await brokerUp())) return;
		const reg = await navigator.serviceWorker.register(`${base}/sw/push.js`, {
			scope: `${base}/sw/`
		});
		reg.active?.postMessage({ roomUrl });
		const { publicKey } = (await (await fetch(`${base}/api/push/vapid`)).json()) as {
			publicKey: string;
		};
		const sub = await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: b64ToBytes(publicKey) as BufferSource
		});
		await fetch(`${base}/api/push/sub`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ...sub.toJSON(), code })
		});
	} catch (e) {
		console.debug('[push] subscribe failed', e);
	}
}

/** called by the room bridge once the session is live */
export function initRoomPush(code: string, roomUrl: string): void {
	if (!enabled()) return;
	activeCode = code;
	activeUrl = roomUrl;
	// subscribe silently only when permission was already granted — never
	// prompt on room entry, that's prod's UX call
	if (Notification.permission === 'granted') void subscribe(code, roomUrl);
	// prod's settings UI calls Notification.requestPermission — piggyback a
	// grant to subscribe without waiting for prod to learn our API
	if (!patched) {
		patched = true;
		const orig = Notification.requestPermission.bind(Notification);
		Notification.requestPermission = async (...args) => {
			const res = await orig(...args);
			if (res === 'granted' && activeCode) void subscribe(activeCode, activeUrl);
			return res;
		};
	}
}

/** entering member rings the code's subscribers (rate-limited per device) */
export function ringRoom(code: string): void {
	if (!enabled()) return;
	void brokerUp().then((up) => {
		if (!up) return;
		doRing(code);
	});
}

function doRing(code: string): void {
	try {
		const key = `cic.ring.${code}`;
		const last = Number(localStorage.getItem(key) ?? 0);
		if (Date.now() - last < RING_COOLDOWN_MS) return;
		localStorage.setItem(key, String(Date.now()));
	} catch {}
	void fetch(`${base}/api/push/ring`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ code })
	}).catch(() => {});
}
