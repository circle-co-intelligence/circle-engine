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
import {
	accountKeys,
	signRequest,
	passkeyEnroll,
	passkeyAssert,
	type PasskeyAssertion
} from '../crypto/accountKey';

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

/** stable device-local identity — the public accountId (a pubkey hash,
 *  safe to expose; spend requires the non-extractable device key's
 *  signature — see crypto/accountKey.ts). Sync read from localStorage. */
export function localAccount(): { accountId: string; delegate?: boolean } | null {
	try {
		const raw = localStorage.getItem('cic.account');
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

/** create or load this device's keypair and publish its derived accountId.
 *  Async — key generation/storage is WebCrypto+IDB. A delegate (linked)
 *  device's stored accountId differs from its key hash by design. */
export async function ensureAccount(): Promise<{ accountId: string }> {
	const stored = localAccount();
	const keys = await accountKeys();
	// legacy random ids and stale primaries yield to the key-derived account;
	// a delegate accountId (set by setLinkedAccount) is kept as-is
	if (!stored || (stored.accountId !== keys.accountId && !stored.delegate)) {
		const account = { accountId: keys.accountId, at: Date.now() };
		try {
			localStorage.setItem('cic.account', JSON.stringify(account));
		} catch {}
		return account;
	}
	return stored;
}

/** device-link completed — act as `accountId` from this device onward */
export function setLinkedAccount(accountId: string): void {
	try {
		localStorage.setItem(
			'cic.account',
			JSON.stringify({ accountId, at: Date.now(), delegate: true })
		);
	} catch {}
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
	sponsored?: Record<string, { budget?: number; spent?: number } | true>;
	devices: { keyHash: string; name?: string; at?: number; primary?: boolean }[];
	passkeys: { credId: string; name?: string; at?: number }[];
	limits: { maxSecondsPerDay?: number } | null;
	activity: { op: string; device: string; at: number; detail?: string }[];
}

export function payBase(): string | null {
	return (import.meta.env as Record<string, string | undefined>).VITE_CIC_PAY_ENDPOINT ?? null;
}

export function billingConfigured(): boolean {
	return payBase() !== null;
}

/**
 * payFetch — signed requests carry x-cic-pub/ts/nonce/sig over the canonical
 * worker path (/pay/*); the accountId claim travels in the signed payload or
 * x-cic-account header, never in a URL (URLs land in logs/history).
 */
async function payFetch(
	path: string,
	init?: RequestInit,
	sign = false
): Promise<Response | null> {
	const b = payBase();
	if (!b) return null;
	let headers = new Headers(init?.headers);
	if (sign) {
		const acc = localAccount();
		if (!acc) return null;
		const body = typeof init?.body === 'string' ? init.body : undefined;
		for (const [k, v] of Object.entries(
			await signRequest(init?.method ?? 'GET', `/pay${path}`, body, acc.accountId)
		))
			headers.set(k, v);
		headers.set('x-cic-account', acc.accountId);
	}
	return fetch(`${b}${path}`, { ...init, headers }).catch(() => null);
}

export async function billingConfig(): Promise<{ packages: PayPack[]; subscription: PaySub | null }> {
	const res = await payFetch('/config');
	if (!res?.ok) return { packages: [], subscription: null };
	return (await res.json()) as { packages: PayPack[]; subscription: PaySub | null };
}

export async function billingAccount(): Promise<BillingAccount | null> {
	const res = await payFetch('/account', { method: 'GET' }, true);
	if (!res?.ok) return null;
	return (await res.json()) as BillingAccount;
}

/** → Stripe Checkout URL for a pack / subscription / direct room top-up.
 *  Unsigned by design — funding an account only ever helps its owner. */
export async function checkoutUrl(
	kind: 'pack' | 'sub' | 'room',
	opts: { packId?: string; room?: string } = {}
): Promise<string | null> {
	const acc = await ensureAccount();
	const res = await payFetch('/checkout', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ accountId: acc.accountId, kind, ...opts })
	});
	if (!res?.ok) return null;
	return ((await res.json()) as { url?: string }).url ?? null;
}

/**
 * Step-up: when the account has passkeys enrolled, fetch a one-time
 * challenge and answer it with a WebAuthn assertion (Touch ID etc).
 * Returns undefined when no passkey is enrolled or the ceremony fails —
 * the worker decides whether that's acceptable for the op.
 */
async function assertionFor(): Promise<PasskeyAssertion | undefined> {
	const ch = await passkeyChallenge();
	if (!ch || ch.credIds.length === 0) return undefined;
	return (await passkeyAssert(ch.credIds, ch.challenge)) ?? undefined;
}

/** → Stripe Billing Portal URL (manage/cancel subscription, invoices).
 *  Signed; passkey-asserted when one is enrolled. */
export async function portalUrl(): Promise<string | null> {
	const acc = localAccount();
	if (!acc) return null;
	const body = JSON.stringify({ accountId: acc.accountId, webauthn: await assertionFor() });
	const res = await payFetch(
		'/portal',
		{ method: 'POST', headers: { 'content-type': 'application/json' }, body },
		true
	);
	if (!res?.ok) return null;
	return ((await res.json()) as { url?: string }).url ?? null;
}

/** move wallet seconds into a room pool (the recording-purchase confirm path) */
export async function convertCredits(
	room: string,
	seconds: number
): Promise<{ status: 'purchased'; seconds: number; balance: number } | { status: 'insufficient' | 'no_paid_funding' | 'unavailable' | 'unauthorized' | 'passkey_required'; credits?: number; available?: number } | null> {
	const acc = localAccount();
	if (!acc) return null;
	const webauthn = seconds > 3600 ? await assertionFor() : undefined;
	const body = JSON.stringify({ accountId: acc.accountId, room, seconds, webauthn });
	const res = await payFetch(
		'/convert',
		{ method: 'POST', headers: { 'content-type': 'application/json' }, body },
		true
	);
	if (!res) return null;
	if (res.status === 401) return { status: 'unauthorized' };
	if (res.status === 428) return { status: 'passkey_required' };
	return (await res.json()) as Awaited<ReturnType<typeof convertCredits>>;
}

/** host opts to cover the circle's paid lanes from their wallet, bounded
 *  by a cumulative per-room budget (seconds; default 4h, max 24h) — a
 *  compromised server can only spend what the host already committed */
export async function sponsorRoom(room: string, on: boolean, budgetSeconds?: number): Promise<boolean> {
	const acc = localAccount();
	if (!acc) return false;
	const body = JSON.stringify({ room, accountId: acc.accountId, on, budgetSeconds });
	const res = await payFetch(
		'/sponsor',
		{ method: 'POST', headers: { 'content-type': 'application/json' }, body },
		true
	);
	return res?.ok === true;
}

// --------------------------------------------------------- device linking
//
// New device parks its pubkey behind a short code; an already-linked device
// approves it with a signature (passkey-asserted when enrolled) — the code
// only ever carries a public key, so the channel needn't be trusted.

export async function deviceLinkBegin(): Promise<string | null> {
	const keys = await accountKeys();
	const res = await payFetch('/link-begin', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ pub: bytesToHex(keys.pub) })
	});
	if (!res?.ok) return null;
	return ((await res.json()) as { code?: string }).code ?? null;
}

/** poll until an existing device approves this device's key → its accountId */
export async function deviceLinkStatus(code: string): Promise<string | null> {
	const res = await payFetch(`/link-status?code=${encodeURIComponent(code)}`);
	if (!res?.ok) return null;
	return ((await res.json()) as { accountId?: string }).accountId ?? null;
}

/** existing device: approve the device that parked code (signed + passkey).
 *  The pending device's pubkey goes into the signed body — MeterBus stores
 *  key:<sha256(pub)> only when the hash matches, so a compromised pay
 *  worker can't substitute an attacker's key. */
export async function deviceLinkApprove(
	code: string
): Promise<{ ok: boolean; accountId?: string; keyHash?: string }> {
	const acc = localAccount();
	if (!acc) return { ok: false };
	const st = await payFetch(`/link-status?code=${encodeURIComponent(code)}`);
	const pub = st?.ok ? ((await st.json()) as { pub?: string }).pub : undefined;
	if (!pub) return { ok: false };
	const body = JSON.stringify({ accountId: acc.accountId, code, pub, webauthn: await assertionFor() });
	const res = await payFetch(
		'/link-approve',
		{ method: 'POST', headers: { 'content-type': 'application/json' }, body },
		true
	);
	if (!res?.ok) return { ok: false };
	return (await res.json()) as { ok: boolean; accountId?: string; keyHash?: string };
}

/** revoke a linked device's key (signed + passkey-asserted) */
export async function deviceRevoke(pubHash: string): Promise<boolean> {
	const acc = localAccount();
	if (!acc) return false;
	const body = JSON.stringify({ accountId: acc.accountId, pubHash, webauthn: await assertionFor() });
	const res = await payFetch(
		'/revoke',
		{ method: 'POST', headers: { 'content-type': 'application/json' }, body },
		true
	);
	return res?.ok === true;
}

// ----------------------------------------------------------- passkey+limits

/** fetch a one-time challenge for a WebAuthn assertion on this account */
export async function passkeyChallenge(): Promise<{ challenge: string; credIds: string[] } | null> {
	const acc = localAccount();
	if (!acc) return null;
	const res = await payFetch('/challenge', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ accountId: acc.accountId })
	});
	if (!res?.ok) return null;
	return (await res.json()) as { challenge: string; credIds: string[] };
}

/** enroll a platform passkey as the step-up factor for high-risk ops */
export async function passkeyRegister(name: string): Promise<boolean> {
	const acc = localAccount();
	if (!acc) return false;
	const cred = await passkeyEnroll(acc.accountId, name);
	if (!cred) return false;
	const body = JSON.stringify({ accountId: acc.accountId, passkey: cred });
	const res = await payFetch(
		'/passkey-register',
		{ method: 'POST', headers: { 'content-type': 'application/json' }, body },
		true
	);
	return res?.ok === true;
}

/** set/clear the optional daily spend cap (seconds/day; null disables) */
export async function setSpendCap(maxSecondsPerDay: number | null): Promise<boolean> {
	const acc = localAccount();
	if (!acc) return false;
	const body = JSON.stringify({
		accountId: acc.accountId,
		maxSecondsPerDay,
		webauthn: await assertionFor()
	});
	const res = await payFetch(
		'/limits',
		{ method: 'POST', headers: { 'content-type': 'application/json' }, body },
		true
	);
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
export async function completeLink(challengeId: string): Promise<boolean> {
	let ch: { roomCode: string; expiresAt: number } | null = null;
	try {
		ch = JSON.parse(localStorage.getItem(`cic.link.${challengeId}`) ?? 'null');
	} catch {}
	if (!ch || Date.now() > ch.expiresAt) return false;
	const acc = await ensureAccount();
	try {
		localStorage.setItem(donePrefix + challengeId, JSON.stringify({ accountId: acc.accountId }));
	} catch {}
	return true;
}
