/**
 * tier.ts — paid-tier entitlement gate + metered spend.
 *
 * Free tier = fully device-assisted: Trystero mesh media, on-device
 * sherpa/wllama/piper AI, local recording. Paid tier = Cloudflare aids every
 * offloadable device resource: SFU fanout (one encode/uplink vs N−1 mesh
 * copies), Workers AI for Milo/STT/TTS, encrypted R2 recording offload,
 * edge denoise + sensory lanes.
 *
 * Spend model — streaming accrual: each room carries a D1-backed seconds
 * pool (`accounts`); clients heartbeat paid-lane usage via /ai/usage, which
 * debits atomically; at zero the room reverts to free/device-side. Top-ups
 * are Ed25519-signed grants (minted by scripts/grant.mjs after a payment
 * settles on whatever rail the operator uses) — sequential top-ups ARE the
 * stream; the pool never locks. `VITE_CIC_AI_PAID_ONLY=false` disables the
 * gate for dev/testing.
 */

import { budget } from './ledger/credits';

export type Tier = 'free' | 'paid';

let cache: { code: string; paid: boolean } | null = null;

function gateOn(): boolean {
	return (import.meta.env as Record<string, string | undefined>).VITE_CIC_AI_PAID_ONLY !== 'false';
}

function apiBase(): string | null {
	return (import.meta.env as Record<string, string | undefined>).VITE_CIC_AI_ENDPOINT ?? null;
}

/** true when this room carries a paid entitlement — metered pool (D1) when
 *  bound, local purchased-credits ledger otherwise */
export async function paidEntitled(roomCode: string): Promise<boolean> {
	if (!gateOn()) return true; // dev override — everything cloud-assisted
	if (cache?.code === roomCode) return cache.paid;
	const paid = await serverEntitled(roomCode).catch(() => null);
	if (paid !== null) {
		cache = { code: roomCode, paid };
		return paid;
	}
	try {
		const b = await budget(roomCode);
		cache = { code: roomCode, paid: b.budget.purchasedSeconds > 0 };
		return cache.paid;
	} catch {
		return false; // ledger unreadable → stay free/device-side
	}
}

/** server-verified entitlement (D1 behind the ai-gateway); null = lane absent */
async function serverEntitled(roomCode: string): Promise<boolean | null> {
	const info = await entitlementInfo(roomCode);
	return info === null ? null : info.paid;
}

export interface Entitlement {
	paid: boolean;
	balanceSeconds: number;
	spentSeconds: number;
}

/** remaining pool + spend — null when the metered lane isn't deployed */
export async function entitlementInfo(roomCode: string): Promise<Entitlement | null> {
	const base = apiBase();
	if (!base) return null;
	const res = await fetch(`${base}/entitlement?room=${encodeURIComponent(roomCode)}`);
	if (!res.ok) return null;
	return (await res.json()) as Entitlement;
}

/**
 * Report paid-lane usage — the streaming-spend heartbeat. Callers pass
 * active seconds per period; AI calls accrue as `calls`. Returns the
 * remaining balance; also invalidates the paid memo when the pool empties.
 */
export async function reportUsage(
	roomCode: string,
	seconds: number,
	calls = 0
): Promise<Entitlement | null> {
	const base = apiBase();
	if (!base || (seconds <= 0 && calls <= 0)) return null;
	const res = await fetch(`${base}/usage`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ room: roomCode, seconds, calls })
	}).catch(() => null);
	if (!res?.ok) return null;
	const body = (await res.json()) as { paid?: boolean; balanceSeconds?: number };
	if (body.paid === false) cache = { code: roomCode, paid: false };
	return { paid: body.paid === true, balanceSeconds: body.balanceSeconds ?? 0, spentSeconds: 0 };
}

/** credit the pool with a signed grant (from the payment rail webhook) */
export async function topUp(roomCode: string, grant: string): Promise<boolean> {
	const base = apiBase();
	if (!base) return false;
	const res = await fetch(`${base}/topup`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ room: roomCode, grant })
	}).catch(() => null);
	if (res?.ok) invalidateTier(roomCode);
	return res?.ok === true;
}

/**
 * UsageMeter — accumulates paid-lane activity, flushes every FLUSH_MS.
 * Lanes: 'sfu' | 'speech' | 'edge' | 'ai' (calls). The session ticks
 * active lanes from its heartbeat; flush debits the pool.
 */
const FLUSH_MS = 30_000;
export class UsageMeter {
	private seconds = 0;
	private calls = 0;
	private timer = 0;
	private exhausted = false;
	constructor(
		private roomCode: string,
		private onExhausted?: () => void
	) {}
	tickSeconds(n: number) {
		this.seconds += n;
	}
	tickCall() {
		this.calls++;
	}
	start() {
		this.timer = window.setInterval(() => void this.flush(), FLUSH_MS);
	}
	async flush() {
		const info = await reportUsage(this.roomCode, this.seconds, this.calls);
		this.seconds = 0;
		this.calls = 0;
		if (info && !info.paid && !this.exhausted) {
			this.exhausted = true; // fire once; a successful top-up resets via reset()
			this.onExhausted?.();
		}
		return info;
	}
	/** re-arm after a top-up credits the pool mid-session */
	reset() {
		this.exhausted = false;
	}
	stop() {
		window.clearInterval(this.timer);
		void this.flush();
	}
}

/** clear the per-code memo (e.g. after a top-up confirms mid-session) */
export function invalidateTier(roomCode?: string) {
	if (!roomCode || cache?.code === roomCode) cache = null;
}
