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
import { localAccount } from './bridge/account';
import { signRequest } from './crypto/accountKey';

export type Tier = 'free' | 'paid';

let cache: { key: string; paid: boolean } | null = null;

function gateOn(): boolean {
	return (import.meta.env as Record<string, string | undefined>).VITE_CIC_AI_PAID_ONLY !== 'false';
}

function apiBase(): string | null {
	return (import.meta.env as Record<string, string | undefined>).VITE_CIC_AI_ENDPOINT ?? null;
}

/** the caller's billing identity — bearer accountId from the local link, or
 *  an explicit override (tests/headless). Never broadcast to peers. */
function callerAccount(account?: string): string | undefined {
	return account ?? localAccount()?.accountId;
}

/** true when paid lanes are covered — the room pool, a host sponsor's
 *  wallet, or the caller's own account balance */
export async function paidEntitled(roomCode: string, account?: string): Promise<boolean> {
	if (!gateOn()) return true; // dev override — everything cloud-assisted
	const acc = callerAccount(account);
	const key = `${roomCode}:${acc ?? ''}`;
	if (cache?.key === key) return cache.paid;
	const paid = await serverEntitled(roomCode, acc).catch(() => null);
	if (paid !== null) {
		cache = { key, paid };
		return paid;
	}
	try {
		const b = await budget(roomCode);
		cache = { key, paid: b.budget.purchasedSeconds > 0 };
		return cache.paid;
	} catch {
		return false; // ledger unreadable → stay free/device-side
	}
}

/** server-verified entitlement (MeterBus behind the ai-gateway); null = lane absent */
async function serverEntitled(roomCode: string, account?: string): Promise<boolean | null> {
	const info = await entitlementInfo(roomCode, account);
	return info === null ? null : info.paid;
}

export interface Entitlement {
	paid: boolean;
	balanceSeconds: number;
	spentSeconds: number;
	source?: 'room' | 'account' | 'sponsor';
}

/** remaining pool + spend — null when the metered lane isn't deployed.
 *  The account lane is signed (x-cic-*) — a bare accountId is a public
 *  identifier, never a credential, and never goes in a URL. */
export async function entitlementInfo(roomCode: string, account?: string): Promise<Entitlement | null> {
	const base = apiBase();
	if (!base) return null;
	const acc = callerAccount(account);
	const headers: Record<string, string> = {};
	if (acc) {
		Object.assign(headers, await signRequest('GET', '/ai/entitlement', undefined, acc));
		headers['x-cic-account'] = acc;
	}
	const res = await fetch(`${base}/entitlement?room=${encodeURIComponent(roomCode)}`, { headers });
	if (!res.ok) return null;
	return (await res.json()) as Entitlement;
}

/**
 * Report paid-lane usage — the streaming-spend heartbeat. Callers pass
 * active seconds per period; AI calls accrue as `calls`. The gateway picks
 * the covering pool: host sponsor → the caller's own account → room pool.
 * Returns the remaining balance; also invalidates the paid memo when the
 * pool empties.
 */
export async function reportUsage(
	roomCode: string,
	seconds: number,
	calls = 0,
	account?: string,
	callIds?: string[]
): Promise<Entitlement | null> {
	const base = apiBase();
	if (!base || (seconds <= 0 && calls <= 0 && !callIds?.length)) return null;
	const acc = callerAccount(account);
	const bodyStr = JSON.stringify({
		room: roomCode,
		seconds,
		calls,
		...(callIds?.length ? { callIds } : {}),
		...(acc ? { account: acc } : {})
	});
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (acc) Object.assign(headers, await signRequest('POST', '/ai/usage', bodyStr, acc));
	const res = await fetch(`${base}/usage`, {
		method: 'POST',
		headers,
		body: bodyStr
	}).catch(() => null);
	if (!res?.ok) return null;
	const body = (await res.json()) as { paid?: boolean; balanceSeconds?: number; source?: Entitlement['source'] };
	if (body.paid === false) cache = { key: `${roomCode}:${acc ?? ''}`, paid: false };
	return {
		paid: body.paid === true,
		balanceSeconds: body.balanceSeconds ?? 0,
		spentSeconds: 0,
		source: body.source
	};
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
	/** per-call ids the gateway already debited — reported for audit/reconcile;
	 *  the pool DO's call:<id> dedupe makes resends free */
	private callIds = new Set<string>();
	private timer = 0;
	private exhausted = false;
	constructor(
		private roomCode: string,
		private onExhausted?: () => void
	) {}
	tickSeconds(n: number) {
		this.seconds += n;
	}
	tickCall(callId?: string) {
		this.calls++;
		if (callId) this.callIds.add(callId);
	}
	start() {
		this.timer = window.setInterval(() => void this.flush(), FLUSH_MS);
	}
	async flush() {
		const ids = [...this.callIds];
		const info = await reportUsage(this.roomCode, this.seconds, this.calls, undefined, ids);
		this.seconds = 0;
		this.calls = 0;
		if (info) this.callIds.clear(); // landed — safe to forget
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
	if (!roomCode || cache?.key.startsWith(`${roomCode}:`)) cache = null;
}
