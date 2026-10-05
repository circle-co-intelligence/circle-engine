/**
 * ux.ts — consent-gated UX telemetry emitter.
 *
 * The vendored app's own analytics client is compiled out (token never
 * issued), but its consent UI, vocabulary and masking are real. This
 * module is the living half of that contract:
 *
 *   consent  → localStorage "cic.uxConsent.v1" {analytics, replay},
 *               written by the vendored toggle; GPC/DNT forces both off
 *   session  → POST /api/ux/session → per-load visitId + HMAC token
 *               (sessionStorage lifetime — no cross-session linking)
 *   events   → vendored schema {token, events:[{v:1,detector:1,visitId,
 *               eventId,seq,at,page,event,release,device,browser,
 *               browserMajor,role,target?,actionId?,step?,...}]}
 *               → Analytics Engine via /api/ux/events
 *   replay   → consent.replay dynamically imports the vendored masked
 *               rrweb recorder; chunks → R2 via /api/ux/replay/*
 *   traffic  → counterscale-compatible /collect hits on the deployed
 *               cic-analytics worker (cookieless; path sanitized so room
 *               codes — join credentials — never reach analytics)
 *   revoke   → stops everything + POST /api/ux/revoke (deletes replay
 *               chunks server-side; events are anonymous by design)
 */
import { base } from '$app/paths';

// ------------------------------------------------------------- constants
const CONSENT_KEY = 'cic.uxConsent.v1';
const SESSION_KEY = 'cic.uxSession';
const BUFFER_MAX = 120;
const BATCH_MAX = 30;
const BATCH_BYTES = 48 * 1024;
const RETRY_MAX = 4;
const FLUSH_MS = 10_000;
const ACTION_TIMEOUT_MS = 8_000;
const RAGE_WINDOW_MS = 1_500;
const RAGE_CLICKS = 3;

const PAGES = new Set(['setup', 'join', 'prejoin', 'room']);
const EVENTS = new Set([
	'visit_start',
	'visit_end',
	'activation',
	'ack',
	'success',
	'failure',
	'dead',
	'rage',
	'step',
	'coverage'
]);
const STEPS = new Set([
	'setup_opened',
	'room_created',
	'prejoin_opened',
	'join_succeeded',
	'tool_opened',
	'tool_acknowledged',
	'tool_succeeded'
]);
const TARGETS = new Set([
	'create_room',
	'join_room',
	'microphone',
	'camera',
	'settings',
	'chat',
	'recording',
	'transcript',
	'milo',
	'share',
	'layout',
	'leave'
]);
const ROLES = new Set(['host', 'participant', 'unknown']);

type Consent = { analytics: boolean; replay: boolean };
type Session = { visitId: string; token: string; exp: number };
type UxEvent = {
	v: 1;
	detector: 1;
	visitId: string;
	eventId: string;
	seq: number;
	at: number;
	page: string;
	event: string;
	release: string;
	device: string;
	browser: string;
	browserMajor: number;
	role: string;
	target?: string;
	actionId?: number;
	step?: string;
	incomplete?: boolean;
	dropped?: number;
};

// ---------------------------------------------------------------- consent
const gpc = (): boolean =>
	typeof navigator !== 'undefined' &&
	(((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl ?? false) ||
		(navigator as Navigator & { doNotTrack?: string | null }).doNotTrack === '1');

function readConsent(): Consent {
	if (gpc()) return { analytics: false, replay: false };
	try {
		const raw = localStorage.getItem(CONSENT_KEY);
		const c = raw ? (JSON.parse(raw) as Partial<Consent>) : {};
		return { analytics: c.analytics === true, replay: c.analytics === true && c.replay === true };
	} catch {
		return { analytics: false, replay: false };
	}
}

// watch consent writes from the vendored UI — same-tab setItem doesn't
// fire a storage event, so we wrap it; cross-tab changes use the event
function watchConsent(onChange: (c: Consent) => void): () => void {
	const orig = Storage.prototype.setItem;
	const wrapped = function (this: Storage, key: string, value: string) {
		orig.call(this, key, value);
		if (key === CONSENT_KEY) onChange(readConsent());
	};
	Storage.prototype.setItem = wrapped;
	const onStorage = (e: StorageEvent) => {
		if (e.key === CONSENT_KEY) onChange(readConsent());
	};
	window.addEventListener('storage', onStorage);
	return () => {
		if (Storage.prototype.setItem === wrapped) Storage.prototype.setItem = orig;
		window.removeEventListener('storage', onStorage);
	};
}

// ---------------------------------------------------------------- helpers
function pageOf(): string {
	if (typeof location === 'undefined') return 'setup';
	const p = location.pathname;
	if (base && p.startsWith(base)) {
		const rest = p.slice(base.length) || '/';
		return pageFor(rest);
	}
	return pageFor(p);
}
function pageFor(p: string): string {
	if (p.startsWith('/room')) return 'room';
	if (p.startsWith('/join')) return 'join';
	if (p.startsWith('/prejoin')) return 'prejoin';
	return 'setup';
}

const UA = typeof navigator === 'undefined' ? '' : navigator.userAgent;
function browserInfo(): { browser: string; major: number } {
	const m =
		UA.match(/Edg\/(\d+)/) ??
		UA.match(/OPR\/(\d+)/) ??
		UA.match(/Chrome\/(\d+)/) ??
		UA.match(/Firefox\/(\d+)/) ??
		UA.match(/Version\/(\d+)[.\d]* Safari\//);
	const name = UA.includes('Edg/')
		? 'Edge'
		: UA.includes('OPR/')
			? 'Opera'
			: UA.includes('Chrome/')
				? 'Chrome'
				: UA.includes('Firefox/')
					? 'Firefox'
					: UA.includes('Safari/')
						? 'Safari'
						: 'other';
	return { browser: name, major: m ? Number(m[1]) : 0 };
}
const deviceInfo = (): string =>
	/iPad|Tablet/i.test(UA) ? 'tablet' : /Mobi|Android/i.test(UA) ? 'mobile' : 'desktop';
const RELEASE = (import.meta.env as Record<string, string | undefined>).VITE_CIC_RELEASE ?? 'dev';
const CS_BASE = ((import.meta.env as Record<string, string | undefined>).VITE_CIC_ANALYTICS_URL ?? '').replace(
	/\/$/,
	''
);

/** counterscale paths must never carry room codes — join credentials */
function sanitizePath(): string {
	const p = location.pathname;
	const rel = base && p.startsWith(base) ? p.slice(base.length) : p;
	if (rel.startsWith('/room')) return '/room';
	if (rel.startsWith('/join')) return '/join';
	if (rel.startsWith('/prejoin')) return '/prejoin';
	return rel.split('?')[0] || '/';
}

// ---------------------------------------------------------------- emitter
class Ux {
	private consent: Consent = { analytics: false, replay: false };
	private sess: Session | null = null;
	private buffer: UxEvent[] = [];
	private seq = 0;
	private actionSeq = 0;
	private role = 'unknown';
	private flushing: Promise<void> | null = null;
	private retries = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private targets = new Set<string>();
	private actions = new Map<number, { target: string; timer: ReturnType<typeof setTimeout> }>();
	private rageLog: number[] = [];
	private replay: { finish?: () => void; cap?: () => void } | null = null;
	private replayAbort: AbortController | null = null;
	private unwatch: (() => void) | null = null;
	private ended = false;

	start() {
		if (this.unwatch) return;
		this.consent = readConsent();
		this.unwatch = watchConsent((c) => this.applyConsent(c));
		window.addEventListener('visibilitychange', this.onVis);
		window.addEventListener('pagehide', this.onHide);
		void this.applyConsent(this.consent);
	}

	private async applyConsent(c: Consent) {
		if (c.analytics && !this.sess) {
			this.sess = await this.mint();
			if (this.sess) {
				this.emit('visit_start');
				this.timer = setInterval(() => void this.flush(), FLUSH_MS);
				this.traffic();
				if (c.replay) void this.startReplay();
			}
		} else if (c.analytics && c.replay && !this.replay) {
			void this.startReplay();
		} else if ((!c.analytics || !c.replay) && this.replay) {
			this.stopReplay(!c.analytics);
		}
		if (!c.analytics && this.sess) await this.revoke();
	}

	private async mint(): Promise<Session | null> {
		// reuse the tab's session across SPA navigations
		try {
			const s = sessionStorage.getItem(SESSION_KEY);
			if (s) {
				const sess = JSON.parse(s) as Session;
				if (sess.exp > Date.now() / 1000 + 60) return sess;
			}
		} catch {}
		try {
			const r = await fetch(`${base}/api/ux/session`, { method: 'POST' });
			if (!r.ok) return null;
			const sess = (await r.json()) as Session;
			sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess));
			return sess;
		} catch {
			return null;
		}
	}

	private event(name: string, extra: Partial<UxEvent> = {}) {
		if (!this.sess || !EVENTS.has(name)) return;
		const seq = ++this.seq;
		const { browser, major } = browserInfo();
		const e: UxEvent = {
			v: 1,
			detector: 1,
			visitId: this.sess.visitId,
			eventId: `${this.sess.visitId}:${seq}`,
			seq,
			at: Date.now(),
			page: pageOf(),
			event: name,
			release: RELEASE,
			device: deviceInfo(),
			browser,
			browserMajor: major,
			role: this.role,
			...extra
		};
		this.buffer.push(e);
		if (this.buffer.length > BUFFER_MAX) this.buffer.splice(0, this.buffer.length - BUFFER_MAX);
		if (this.buffer.length >= BATCH_MAX) void this.flush();
	}

	private emit(name: string, extra: Partial<UxEvent> = {}) {
		this.event(name, extra);
	}

	private async flush(keepalive = false) {
		if (this.flushing || !this.buffer.length || !this.sess) return;
		const batch = this.buffer.splice(0, BATCH_MAX);
		const body = JSON.stringify({ token: this.sess.token, events: batch });
		if (body.length > BATCH_BYTES) {
			this.buffer.unshift(...batch.slice(Math.floor(BATCH_MAX / 2)));
			return;
		}
		const token = this.sess.token;
		this.flushing = (async () => {
			try {
				const r = await fetch(`${base}/api/ux/events`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body,
					keepalive: keepalive && body.length <= 60_000
				});
				if (r.ok) {
					this.retries = 0;
				} else if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
					// 4xx = schema/auth rejection — drop, never retry
					this.retries = 0;
				} else if (this.sess?.token === token && ++this.retries <= RETRY_MAX) {
					this.buffer.unshift(...batch);
				}
			} catch {
				if (this.sess?.token === token && ++this.retries <= RETRY_MAX) this.buffer.unshift(...batch);
			}
		})().finally(() => {
			this.flushing = null;
		});
		await this.flushing;
		if (this.buffer.length) void this.flush(keepalive);
	}

	private async revoke() {
		const sess = this.sess;
		this.sess = null;
		this.ended = true;
		this.stopReplay(false);
		this.buffer = [];
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		try {
			sessionStorage.removeItem(SESSION_KEY);
		} catch {}
		if (sess)
			try {
				await fetch(`${base}/api/ux/revoke`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ token: sess.token }),
					keepalive: true
				});
			} catch {}
	}

	// ------------------------------------------------------- action tracker
	// mirrors the vendored lS() semantics: activate() starts a timed action;
	// no ack/success/failure within ACTION_TIMEOUT → 'dead'; RAGE_CLICKS
	// activations on one target inside RAGE_WINDOW → 'rage'
	activate(target: string): number | null {
		if (!this.sess || !TARGETS.has(target)) return null;
		const id = ++this.actionSeq;
		this.targets.add(target);
		this.event('activation', { target, actionId: id });
		const now = Date.now();
		this.rageLog = this.rageLog.filter((t) => now - t < RAGE_WINDOW_MS);
		this.rageLog.push(now);
		if (this.rageLog.length >= RAGE_CLICKS) this.event('rage', { target, actionId: id });
		const a = {
			target,
			timer: setTimeout(() => {
				if (this.actions.delete(id)) this.event('dead', { target, actionId: id });
			}, ACTION_TIMEOUT_MS)
		};
		this.actions.set(id, a);
		return id;
	}
	private done(id: number | null, name: 'ack' | 'success' | 'failure') {
		if (id === null || !this.sess) return;
		const a = this.actions.get(id);
		if (a) {
			clearTimeout(a.timer);
			this.actions.delete(id);
			this.event(name, { target: a.target, actionId: id });
		}
	}
	ack(id: number | null) {
		this.done(id, 'ack');
	}
	success(id: number | null) {
		this.done(id, 'success');
	}
	failure(id: number | null) {
		this.done(id, 'failure');
	}

	step(name: string) {
		if (STEPS.has(name)) this.event('step', { step: name });
	}
	setRole(role: string) {
		if (ROLES.has(role)) this.role = role;
	}

	// ---------------------------------------------------------- counterscale
	// Upstream's cookieless scheme verbatim: GET /cache returns {ht} and a
	// Last-Modified encoding the hit count; the BROWSER's HTTP cache resends
	// it as If-Modified-Since on the next load (fetch can't set that header
	// itself — it's forbidden). Then /collect carries ht as a param.
	private async traffic() {
		if (!CS_BASE || !this.sess) return;
		try {
			let ht = '';
			try {
				const c = await fetch(`${CS_BASE}/cache?sid=circle-engine`, { cache: 'no-cache' });
				const j = (await c.json()) as { ht?: number };
				if (j.ht) ht = `&ht=${Math.min(3, Math.max(1, j.ht))}`;
			} catch {}
			await fetch(
				`${CS_BASE}/collect?sid=circle-engine&h=${encodeURIComponent(location.host)}&p=${encodeURIComponent(
					sanitizePath()
				)}&r=${encodeURIComponent(document.referrer ? new URL(document.referrer).host : '')}${ht}`
			);
		} catch {
			/* traffic lane must never break the app */
		}
	}

	// ------------------------------------------------------------- replay
	private async startReplay() {
		if (this.replay || !this.sess || gpc()) return;
		try {
			const meta = await fetch(`${base}/cic/replay-chunk.txt`, { cache: 'no-store' });
			if (!meta.ok) return;
			const chunk = (await meta.text()).trim();
			if (!/^[\w.-]+\.js$/.test(chunk)) return;
			const mod = (await import(/* @vite-ignore */ `${base}/cic/chunks/${chunk}`)) as Record<
				string,
				(ctx: { token: string; visitId: string; baseUrl: string; signal: AbortSignal }, o: { page: string }) => { finish?: () => void; cap?: () => void }
			>;
			const create = mod.createReplayRecorder ?? mod.startReplayRecorder;
			if (!create) return;
			this.replayAbort = new AbortController();
			this.replay = create(
				{
					token: this.sess.token,
					visitId: this.sess.visitId,
					baseUrl: location.origin + base,
					signal: this.replayAbort.signal
				},
				{ page: pageOf() }
			);
		} catch {
			this.replay = null;
		}
	}
	private stopReplay(full: boolean) {
		try {
			if (full) this.replay?.finish?.();
			else this.replay?.cap?.();
		} catch {}
		this.replayAbort?.abort();
		this.replay = null;
		this.replayAbort = null;
	}

	private onVis = () => {
		if (document.visibilityState === 'hidden') void this.flush(true);
	};
	private onHide = () => {
		if (!this.sess) return;
		this.event('visit_end', { incomplete: this.actions.size > 0 });
		this.event('coverage');
		this.stopReplay(true);
		void this.flush(true);
	};

	dispose() {
		this.unwatch?.();
		this.unwatch = null;
		window.removeEventListener('visibilitychange', this.onVis);
		window.removeEventListener('pagehide', this.onHide);
	}
}

// ------------------------------------------------------------------ export
let singleton: Ux | null = null;
export function initUx(): Ux | null {
	if (typeof window === 'undefined') return null;
	if (!singleton) {
		singleton = new Ux();
		singleton.start();
		// test seam — probes drive flush/consent through the same object the
		// emitters use; no production code path touches this
		(window as unknown as { __ux: Ux }).__ux = singleton;
	}
	return singleton;
}
export function ux(): Ux | null {
	return singleton;
}
