/**
 * Credits ledger — Dexie/IndexedDB quotes, account-wallet settlement.
 * When the user is linked and cic-pay is configured, quotes price against
 * their Stripe-backed account wallet and confirms move wallet seconds into
 * the room pool (/pay/convert). Otherwise the local ledger stands in —
 * confirms grant seconds locally (no payment rail, recorded honestly).
 * Local recording itself is unbounded (remainingSeconds: null = "Unlimited").
 */
import Dexie, { type EntityTable } from 'dexie';
import { localAccount, billingConfigured, billingAccount, convertCredits } from '../bridge/account';

export interface Quote {
	quoteId: string;
	roomCode: string;
	blocks: number;
	seconds: number;
	credits: number;
	expiresAt: number;
}

interface Account {
	roomCode: string;
	purchasedSeconds: number;
	updatedAt: number;
}

const db = new Dexie('cic-ledger') as Dexie & {
	accounts: EntityTable<Account, 'roomCode'>;
	quotes: EntityTable<Quote, 'quoteId'>;
};
db.version(1).stores({
	accounts: 'roomCode',
	quotes: 'quoteId, roomCode, expiresAt'
});

const BLOCK_SECONDS = 1800; // prod's recording-purchase blocks are 30-minute units
const QUOTE_MS = 5 * 60_000;

async function account(roomCode: string): Promise<Account> {
	const found = await db.accounts.get(roomCode);
	return found ?? { roomCode, purchasedSeconds: 0, updatedAt: Date.now() };
}

/** prod recording-budget shape — unlimited local recording + real purchased balance */
export async function budget(roomCode: string) {
	const acc = await account(roomCode);
	return {
		budget: {
			accounting: 'reserved-v1',
			heldSeconds: 0,
			purchasedSeconds: acc.purchasedSeconds,
			sessionReservedSeconds: 0,
			limitSeconds: null,
			usedSeconds: 0,
			remainingSeconds: null,
			month: new Date().toISOString().slice(0, 7)
		},
		canPurchase: true
	};
}

/** prod recording-purchase{action:'quote', blocks} → result{status:'quoted', ...}
 *  Wallet path prices 1 credit = 1 account second and reports the real
 *  server balance; the local fallback keeps credits at 0 (no payment rail). */
export async function quote(roomCode: string, blocks: number) {
	const wallet = await walletBalance();
	const q: Quote = {
		quoteId: crypto.randomUUID(),
		roomCode,
		blocks,
		seconds: Math.max(1, blocks) * BLOCK_SECONDS,
		credits: wallet === null ? 0 : Math.max(1, blocks) * BLOCK_SECONDS,
		expiresAt: Date.now() + QUOTE_MS
	};
	await db.quotes.put(q);
	const acc = await account(roomCode);
	return {
		status: 'quoted',
		quoteId: q.quoteId,
		seconds: q.seconds,
		credits: q.credits,
		availablePurchasedCredits: wallet ?? acc.purchasedSeconds,
		quoteExpiresAt: new Date(q.expiresAt).toISOString(),
		timeExpiresAt: null // purchased time does not expire
	};
}

export type ConfirmResult =
	| { status: 'purchased'; seconds: number; balance: number }
	| { status: 'expired' | 'stale' | 'unavailable' }
	| { status: 'insufficient'; credits: number; available: number }
	| { status: 'no_paid_funding' };

/** the user's server-side wallet balance — null when unlinked/unconfigured */
async function walletBalance(): Promise<number | null> {
	if (!billingConfigured() || !localAccount()) return null;
	return (await billingAccount())?.balanceSeconds ?? null;
}

/** prod recording-purchase{action:'confirm', quoteId} — converts wallet
 *  seconds into room-pool seconds via cic-pay; local ledger when offline */
export async function confirm(roomCode: string, quoteId: string): Promise<ConfirmResult> {
	const q = await db.quotes.get(quoteId);
	if (!q || q.roomCode !== roomCode) return { status: 'stale' };
	await db.quotes.delete(quoteId); // a quote confirms once
	if (Date.now() > q.expiresAt) return { status: 'expired' };

	const wallet = await walletBalance();
	if (wallet !== null) {
		// Stripe-backed path — the DO floors at the real wallet balance
		const r = await convertCredits(roomCode, q.seconds);
		if (!r) return { status: 'unavailable' };
		if (r.status === 'insufficient')
			return { status: 'insufficient', credits: r.credits ?? q.credits, available: r.available ?? 0 };
		if (r.status === 'no_paid_funding') return { status: 'no_paid_funding' };
		if (r.status === 'purchased')
			return { status: 'purchased', seconds: r.seconds, balance: r.balance };
		return { status: 'unavailable' };
	}

	// unlinked / payments not configured — local ledger grants locally
	const acc = await account(roomCode);
	acc.purchasedSeconds += q.seconds;
	acc.updatedAt = Date.now();
	await db.accounts.put(acc);
	return { status: 'purchased', seconds: q.seconds, balance: acc.purchasedSeconds };
}

export async function balance(roomCode: string): Promise<number> {
	return (await account(roomCode)).purchasedSeconds;
}
