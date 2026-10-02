/**
 * tier.ts — paid-tier entitlement gate.
 *
 * Free tier = fully device-assisted: Trystero mesh media, on-device
 * sherpa/wllama/piper AI, local recording. Paid tier = Cloudflare aids every
 * offloadable device resource: SFU fanout (one encode/uplink vs N−1 mesh
 * copies), Workers AI for Milo/STT/TTS, encrypted R2 recording offload.
 *
 * Entitlement is per-room (roomCode keyed): a positive purchased-credits
 * balance in the ledger. The shape is ready for a D1-verified signed grant —
 * `paidEntitled` is the single seam; swap the lookup when the grant service
 * lands, call sites don't change.
 *
 * `VITE_CIC_AI_PAID_ONLY=false` disables the gate for dev/testing.
 */

import { budget } from './ledger/credits';

export type Tier = 'free' | 'paid';

let cache: { code: string; paid: boolean } | null = null;

function gateOn(): boolean {
	return (import.meta.env as Record<string, string | undefined>).VITE_CIC_AI_PAID_ONLY !== 'false';
}

/** true when this room carries a paid entitlement — D1-verified when the
 *  ai-gateway exposes /ai/entitlement, local purchased-credits otherwise */
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
	const base = (import.meta.env as Record<string, string | undefined>).VITE_CIC_AI_ENDPOINT;
	if (!base) return null;
	const res = await fetch(`${base}/entitlement?room=${encodeURIComponent(roomCode)}`);
	if (!res.ok) return null;
	const body = (await res.json()) as { paid?: boolean };
	return body.paid === true;
}

/** clear the per-code memo (e.g. after a purchase confirms mid-session) */
export function invalidateTier(roomCode?: string) {
	if (!roomCode || cache?.code === roomCode) cache = null;
}
