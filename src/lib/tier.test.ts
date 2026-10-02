import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { reportUsage, topUp, UsageMeter, invalidateTier } from './tier';

const EP = 'https://ai.test';

function mockFetch(handler: (body: unknown, url: string) => object | null) {
	return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const body = init?.body ? JSON.parse(init.body as string) : null;
		const out = handler(body, url.toString());
		if (out === null) return { ok: false, status: 500, json: async () => ({}) } as Response;
		return { ok: true, status: 200, json: async () => out } as Response;
	});
}

beforeEach(() => {
	vi.stubEnv('VITE_CIC_AI_ENDPOINT', EP);
	vi.stubEnv('VITE_CIC_AI_PAID_ONLY', 'true');
	invalidateTier();
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe('reportUsage — metered spend', () => {
	it('POSTs seconds+calls and returns the balance', async () => {
		const f = mockFetch((body) => {
			expect(body).toEqual({ room: 'r1', seconds: 30, calls: 2 });
			return { paid: true, balanceSeconds: 970 };
		});
		vi.stubGlobal('fetch', f);
		const info = await reportUsage('r1', 30, 2);
		expect(info).toEqual({ paid: true, balanceSeconds: 970, spentSeconds: 0 });
		expect(f).toHaveBeenCalledWith(`${EP}/usage`, expect.objectContaining({ method: 'POST' }));
	});

	it('skips the network when nothing accrued or no endpoint', async () => {
		const f = vi.fn();
		vi.stubGlobal('fetch', f);
		expect(await reportUsage('r1', 0, 0)).toBeNull();
		expect(f).not.toHaveBeenCalled();
	});

	it('tolerates network failure without throwing', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('down'))));
		expect(await reportUsage('r1', 10)).toBeNull();
	});
});

describe('UsageMeter — streaming accrual', () => {
	it('batches ticks into one flush and fires onExhausted once', async () => {
		let balance = 100;
		const f = mockFetch((body) => {
			const b = body as { seconds: number };
			balance = Math.max(0, balance - b.seconds);
			return { paid: balance > 0, balanceSeconds: balance };
		});
		vi.stubGlobal('fetch', f);
		const exhausted = vi.fn();
		const m = new UsageMeter('r2', exhausted);
		m.tickSeconds(60);
		m.tickSeconds(50); // 110 total → drains the 100 pool
		await m.flush();
		expect(balance).toBe(0);
		expect(exhausted).toHaveBeenCalledTimes(1);
		m.tickSeconds(10);
		await m.flush();
		expect(exhausted).toHaveBeenCalledTimes(1); // once, not per flush
		m.reset();
		balance = 5;
		m.tickSeconds(10);
		await m.flush();
		expect(exhausted).toHaveBeenCalledTimes(2); // re-armed after top-up
	});
});

describe('topUp — signed grants', () => {
	it('POSTs the grant and returns ok', async () => {
		const f = mockFetch((body) => {
			expect(body).toEqual({ room: 'r3', grant: 'g123' });
			return { ok: true, creditedSeconds: 3600 };
		});
		vi.stubGlobal('fetch', f);
		expect(await topUp('r3', 'g123')).toBe(true);
	});

	it('grant signatures round-trip through WebCrypto Ed25519 (worker path)', async () => {
		// script mints with @noble/curves; the worker verifies with crypto.subtle —
		// this proves the formats agree before anything deploys
		const secret = randomBytes(32);
		const pub = ed25519.getPublicKey(secret) as Uint8Array<ArrayBuffer>;
		const [room, seconds, nonce] = ['r4', 3600, bytesToHex(randomBytes(16))];
		const sig = ed25519.sign(
			new TextEncoder().encode(`${room}.${seconds}.${nonce}`),
			secret
		) as Uint8Array<ArrayBuffer>;
		const key = await crypto.subtle.importKey('raw', pub, 'Ed25519', false, ['verify']);
		const ok = await crypto.subtle.verify(
			'Ed25519',
			key,
			sig,
			new TextEncoder().encode(`${room}.${seconds}.${nonce}`)
		);
		expect(ok).toBe(true);
		// tampering fails
		const bad = await crypto.subtle.verify(
			'Ed25519',
			key,
			sig,
			new TextEncoder().encode(`other.${seconds}.${nonce}`)
		);
		expect(bad).toBe(false);
		// and noble verifies WebCrypto-signed grants the other way, for parity
		const subtleKey = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
		const msg = new TextEncoder().encode('r5.60.aa');
		const wsSig = new Uint8Array(
			new Uint8Array(await crypto.subtle.sign('Ed25519', subtleKey.privateKey, msg)).buffer as ArrayBuffer
		);
		const wsPub = new Uint8Array(
			new Uint8Array(await crypto.subtle.exportKey('raw', subtleKey.publicKey)).buffer as ArrayBuffer
		);
		expect(ed25519.verify(wsSig, msg, wsPub)).toBe(true);
		expect(hexToBytes(bytesToHex(wsPub))).toEqual(wsPub);
	});
});
