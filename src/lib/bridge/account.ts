/**
 * Local account linking — no provider, no server. Prod's flow: the room
 * socket answers account-link-start with a challenge{loginUrl,pollSecret};
 * the app opens loginUrl in a second tab which calls back into the account
 * system; the room tab polls every 2s until account-linked{accountId}.
 *
 * Ours is the same protocol terminated locally: the challenge lives in
 * localStorage so the /account/link tab can resolve it, the room tab polls
 * here, and linking produces a stable local accountId + sessionToken that
 * subsequent hello frames carry (prod sends sessionToken verbatim).
 */
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base } from '$app/paths';

interface Challenge {
	challengeId: string;
	pollSecret: string;
	roomCode: string;
	expiresAt: number;
}

const CHALLENGE_MS = 10 * 60_000;
const pending = new Map<string, Challenge>(); // challengeId → challenge (this tab)
const donePrefix = 'cic.linkdone.';

function randomToken(): string {
	const b = new Uint8Array(24);
	crypto.getRandomValues(b);
	return bytesToHex(b);
}

/** stable device-local identity — created only when the user actually links */
export function localAccount(): { accountId: string } | null {
	try {
		const raw = localStorage.getItem('cic.account');
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

export function ensureAccount(): { accountId: string } {
	const found = localAccount();
	if (found) return found;
	const accountId = bytesToHex(sha256(new TextEncoder().encode(`cic:${crypto.randomUUID()}`))).slice(0, 32);
	try {
		localStorage.setItem('cic.account', JSON.stringify({ accountId, at: Date.now() }));
	} catch {}
	return { accountId };
}

// ------------------------------------------------------------- billing
//
// The accountId doubles as the bearer billing credential — Stripe Checkout
// binds payments to it, the cic-pay worker credits its wallet. It never
// leaves this device except to our own pay endpoints.

export interface PayPack {
	id: string;
	label: string;
	seconds: number;
	priceId: string;
	amountCents?: number;
	currency?: string;
}
export interface PaySub {
	priceId: string;
	seconds: number;
	label: string;
	amountCents?: number;
	currency?: string;
}
export interface BillingAccount {
	accountId: string;
	balanceSeconds: number;
	spentSeconds: number;
	subscription: {
		id?: string;
		status?: string;
		cancelAtPeriodEnd?: boolean;
		currentPeriodEnd?: number | null;
	} | null;
	customerId: string | null;
	sponsoredRooms: string[];
}

export function payBase(): string | null {
	return (import.meta.env as Record<string, string | undefined>).VITE_CIC_PAY_ENDPOINT ?? null;
}

export function billingConfigured(): boolean {
	return payBase() !== null;
}

async function payFetch(path: string, init?: RequestInit): Promise<Response | null> {
	const b = payBase();
	if (!b) return null;
	return fetch(`${b}${path}`, init).catch(() => null);
}

export async function billingConfig(): Promise<{ packages: PayPack[]; subscription: PaySub | null }> {
	const res = await payFetch('/config');
	if (!res?.ok) return { packages: [], subscription: null };
	return (await res.json()) as { packages: PayPack[]; subscription: PaySub | null };
}

export async function billingAccount(): Promise<BillingAccount | null> {
	const acc = localAccount();
	if (!acc) return null;
	const res = await payFetch(`/account?account=${encodeURIComponent(acc.accountId)}`);
	if (!res?.ok) return null;
	return (await res.json()) as BillingAccount;
}

/** → Stripe Checkout URL for a pack / subscription / direct room top-up */
export async function checkoutUrl(
	kind: 'pack' | 'sub' | 'room',
	opts: { packId?: string; room?: string } = {}
): Promise<string | null> {
	const acc = ensureAccount();
	const res = await payFetch('/checkout', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ accountId: acc.accountId, kind, ...opts })
	});
	if (!res?.ok) return null;
	return ((await res.json()) as { url?: string }).url ?? null;
}

/** → Stripe Billing Portal URL (manage/cancel subscription, invoices) */
export async function portalUrl(): Promise<string | null> {
	const acc = localAccount();
	if (!acc) return null;
	const res = await payFetch('/portal', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ accountId: acc.accountId })
	});
	if (!res?.ok) return null;
	return ((await res.json()) as { url?: string }).url ?? null;
}

/** move wallet seconds into a room pool (the recording-purchase confirm path) */
export async function convertCredits(
	room: string,
	seconds: number
): Promise<{ status: 'purchased'; seconds: number; balance: number } | { status: 'insufficient' | 'no_paid_funding' | 'unavailable'; credits?: number; available?: number } | null> {
	const acc = localAccount();
	if (!acc) return null;
	const res = await payFetch('/convert', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ accountId: acc.accountId, room, seconds })
	});
	if (!res) return null;
	return (await res.json()) as Awaited<ReturnType<typeof convertCredits>>;
}

/** host opts to cover the whole circle's paid lanes from their wallet */
export async function sponsorRoom(room: string, on: boolean): Promise<boolean> {
	const acc = localAccount();
	if (!acc) return false;
	const res = await payFetch('/sponsor', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ room, accountId: acc.accountId, on })
	});
	return res?.ok === true;
}

/** sessionToken for welcome/hello — stable per account, re-issued per room */
export function sessionToken(roomCode: string): string | null {
	const acc = localAccount();
	if (!acc) return null;
	return bytesToHex(sha256(new TextEncoder().encode(`${acc.accountId}:${roomCode}`))).slice(0, 40);
}

/** room tab: prod account-link-start → challenge frame */
export function startLink(roomCode: string): Challenge & { loginUrl: string } {
	const challengeId = randomToken();
	const pollSecret = randomToken();
	const ch: Challenge = { challengeId, pollSecret, roomCode, expiresAt: Date.now() + CHALLENGE_MS };
	pending.set(challengeId, ch);
	// the link page resolves by challengeId — pollSecret never leaves this tab
	try {
		localStorage.setItem(`cic.link.${challengeId}`, JSON.stringify({ roomCode, expiresAt: ch.expiresAt }));
	} catch {}
	return { ...ch, loginUrl: `${base}/account/link?ch=${challengeId}` };
}

/** room tab: prod account-link-poll{challengeId,pollSecret} → accountId | null */
export function pollLink(challengeId: string, pollSecret: string): string | null {
	const ch = pending.get(challengeId);
	if (!ch || ch.pollSecret !== pollSecret || Date.now() > ch.expiresAt) return null;
	try {
		const raw = localStorage.getItem(donePrefix + challengeId);
		if (!raw) return null;
		const { accountId } = JSON.parse(raw);
		pending.delete(challengeId);
		localStorage.removeItem(`cic.link.${challengeId}`);
		localStorage.removeItem(donePrefix + challengeId);
		return String(accountId);
	} catch {
		return null;
	}
}

/** link tab: resolve a challenge — proves the tab is same-origin + consented */
export function completeLink(challengeId: string): boolean {
	let ch: { roomCode: string; expiresAt: number } | null = null;
	try {
		ch = JSON.parse(localStorage.getItem(`cic.link.${challengeId}`) ?? 'null');
	} catch {}
	if (!ch || Date.now() > ch.expiresAt) return false;
	const acc = ensureAccount();
	try {
		localStorage.setItem(donePrefix + challengeId, JSON.stringify({ accountId: acc.accountId }));
	} catch {}
	return true;
}
