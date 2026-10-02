/**
 * Local credits ledger — Dexie/IndexedDB, device-resident.
 * Production's recording budget is server-accounted; ours is a real local
 * ledger: quotes create pending offers, confirms grant purchased seconds.
 * Local recording itself is unbounded (remainingSeconds: null = "Unlimited"),
 * purchased seconds track the paid-tier surface honestly — no server claim.
 */
import Dexie, { type EntityTable } from 'dexie';

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

/** prod recording-purchase{action:'quote', blocks} → result{status:'quoted', ...} */
export async function quote(roomCode: string, blocks: number) {
	const q: Quote = {
		quoteId: crypto.randomUUID(),
		roomCode,
		blocks,
		seconds: Math.max(1, blocks) * BLOCK_SECONDS,
		credits: 0, // local ledger — no payment lane exists; recorded honestly as 0
		expiresAt: Date.now() + QUOTE_MS
	};
	await db.quotes.put(q);
	const acc = await account(roomCode);
	return {
		status: 'quoted',
		quoteId: q.quoteId,
		seconds: q.seconds,
		credits: q.credits,
		availablePurchasedCredits: acc.purchasedSeconds,
		quoteExpiresAt: new Date(q.expiresAt).toISOString(),
		timeExpiresAt: null // purchased time does not expire
	};
}

export type ConfirmResult =
	| { status: 'purchased'; seconds: number; balance: number }
	| { status: 'expired' | 'stale' | 'unavailable' };

/** prod recording-purchase{action:'confirm', quoteId} — grants the quoted seconds */
export async function confirm(roomCode: string, quoteId: string): Promise<ConfirmResult> {
	const q = await db.quotes.get(quoteId);
	if (!q || q.roomCode !== roomCode) return { status: 'stale' };
	await db.quotes.delete(quoteId); // a quote confirms once
	if (Date.now() > q.expiresAt) return { status: 'expired' };
	const acc = await account(roomCode);
	acc.purchasedSeconds += q.seconds;
	acc.updatedAt = Date.now();
	await db.accounts.put(acc);
	return { status: 'purchased', seconds: q.seconds, balance: acc.purchasedSeconds };
}

export async function balance(roomCode: string): Promise<number> {
	return (await account(roomCode)).purchasedSeconds;
}
