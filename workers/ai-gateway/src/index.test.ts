import { describe, it, expect } from 'vitest';
import { MeterBus } from './index';

// ------------------------------------------------------------ test harness
// MeterBus is instantiated directly with a fake DurableObjectState so the
// real gate logic (token ACL, instance binding, acct spend auth) is tested.

const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256hex = async (d: Uint8Array | string) =>
	toHex(
		new Uint8Array(
			await crypto.subtle.digest(
				'SHA-256',
				(typeof d === 'string' ? new TextEncoder().encode(d) : d) as BufferSource
			)
		)
	);

function fakeStorage() {
	const m = new Map<string, unknown>();
	return {
		map: m,
		get: async (k: string) => m.get(k),
		put: async (k: string | Record<string, unknown>, v?: unknown) => {
			if (typeof k === 'string') m.set(k, v);
			else for (const [kk, vv] of Object.entries(k)) m.set(kk, vv);
		},
		delete: async (k: string) => m.delete(k),
		list: async (o?: { prefix?: string }) => {
			const out = new Map<string, unknown>();
			for (const [k, v] of m) if (!o?.prefix || k.startsWith(o.prefix)) out.set(k, v);
			return out;
		}
	};
}

/** deterministic fake DurableObjectId — name acts as the id string */
const fakeId = (name: string) =>
	({
		toString: () => name,
		equals: (o: { toString(): string }) => String(o) === name
	}) as unknown as DurableObjectId;

const TOKENS = { admin: 'mt_admin', spend: 'mt_spend', probe: 'mt_probe', settle: 'mt_settle' };

async function makeEnv(stores: Map<string, ReturnType<typeof fakeStorage>>, withAcl = true) {
	const acl: Record<string, string> = {};
	for (const [role, tok] of Object.entries(TOKENS)) acl[await sha256hex(tok)] = role;
	return {
		METER_ACL: withAcl ? JSON.stringify(acl) : undefined,
		METER_TOKEN: TOKENS.spend, // the DO's own internal-call token
		METER: {
			idFromName: (n: string) => fakeId(n),
			get: (id: DurableObjectId) => ({
				// intra-DO calls (transfer → credit the target room instance)
				fetch: async (_u: string, init?: RequestInit) => {
					const name = String(id);
					const st = stores.get(name) ?? stores.set(name, fakeStorage()).get(name)!;
					const b = JSON.parse((init?.body as string) ?? '{}') as { amount?: number };
					st.map.set('balance', ((st.map.get('balance') as number) ?? 0) + (b.amount ?? 0));
					return new Response(JSON.stringify({ ok: true, balanceSeconds: st.map.get('balance') }));
				}
			})
		} as unknown as DurableObjectNamespace
	};
}

function makeDo(name: string, env: ReturnType<typeof makeEnv> extends Promise<infer T> ? T : never, stores: Map<string, ReturnType<typeof fakeStorage>>) {
	const st = stores.get(name) ?? stores.set(name, fakeStorage()).get(name)!;
	const ctx = { id: fakeId(name), storage: st } as unknown as DurableObjectState;
	return { mb: new MeterBus(ctx, env), store: st };
}

async function call(
	mb: MeterBus,
	name: string,
	op: string,
	token: string,
	body: Record<string, unknown> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await mb.fetch(
		new Request(`https://meter${op}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-meter-token': token },
			body: JSON.stringify({ inst: name, ...body })
		})
	);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function deviceKey() {
	const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
	const pub = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
	return { pair, pub, keyHash: await sha256hex(pub) };
}

/** a client's signed request, packaged for DO forwarding */
async function signAuth(
	dev: Awaited<ReturnType<typeof deviceKey>>,
	acct: string,
	path: string,
	bodyObj: object,
	over: { nonce?: string; ts?: number; signBody?: object } = {}
) {
	const body = JSON.stringify(bodyObj);
	const ts = over.ts ?? Math.floor(Date.now() / 1000);
	const nonce = over.nonce ?? crypto.randomUUID();
	const bodyHash = await sha256hex(JSON.stringify(over.signBody ?? bodyObj));
	const payload = [acct, 'POST', path, bodyHash, String(ts), nonce, dev.keyHash].join('\n');
	const sig = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		dev.pair.privateKey,
		new TextEncoder().encode(payload)
	);
	return { pub: toHex(dev.pub), ts, nonce, sig: toHex(new Uint8Array(sig)), method: 'POST', path, body };
}

// ------------------------------------------------------------ tests

describe('MeterBus hardened mode', () => {
	it('rejects calls with no/unknown token', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores);
		const { mb } = makeDo('room1', env, stores);
		expect((await call(mb, 'room1', '/get', '')).status).toBe(401);
		expect((await call(mb, 'room1', '/get', 'mt_wrong')).status).toBe(401);
		expect((await call(mb, 'room1', '/get', TOKENS.probe)).status).toBe(200);
	});

	it('rejects instance-name spoofing', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores);
		const { mb, store } = makeDo('roomA', env, stores);
		store.map.set('balance', 100);
		// caller claims inst 'roomB' but lands on roomA's DO
		const res = await mb.fetch(
			new Request('https://meter/debit', {
				method: 'POST',
				headers: { 'x-meter-token': TOKENS.spend },
				body: JSON.stringify({ inst: 'roomB', amount: 50 })
			})
		);
		expect(res.status).toBe(400);
		expect(store.map.get('balance')).toBe(100);
	});

	it('scopes ops by role — probe cannot write or debit', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores);
		const { mb, store } = makeDo('room2', env, stores);
		store.map.set('balance', 100);
		expect((await call(mb, 'room2', '/debit', TOKENS.probe, { amount: 10 })).status).toBe(403);
		expect((await call(mb, 'room2', '/kvput', TOKENS.probe, { key: 'x', value: 1 })).status).toBe(403);
		expect(store.map.get('balance')).toBe(100);
	});

	it('rejects unsigned wallet debit — spend token alone cannot drain acct:*', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores);
		const acct = 'c'.repeat(64);
		const { mb, store } = makeDo(`acct:${acct}`, env, stores);
		store.map.set('balance', 9000);
		const res = await call(mb, `acct:${acct}`, '/debit', TOKENS.spend, { amount: 9000 });
		expect(res.status).toBe(401);
		expect(store.map.get('balance')).toBe(9000);
	});

	it('debits a wallet only up to the client-signed amount', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores);
		const dev = await deviceKey();
		const { mb, store } = makeDo(`acct:${dev.keyHash}`, env, stores);
		store.map.set('balance', 5000);
		// usage signed for 100s; worker claims 9999 — DO debits the SIGNED 100
		const auth = await signAuth(dev, dev.keyHash, '/ai/usage', { room: 'R1', seconds: 100, account: dev.keyHash });
		const res = await call(mb, `acct:${dev.keyHash}`, '/debit', TOKENS.spend, { amount: 9999, room: 'R1', auth });
		expect(res.status).toBe(200);
		expect(store.map.get('balance')).toBe(4900);
		expect(res.body.debitedSeconds).toBe(100);
	});

	it('rejects replayed and cross-account signed auth', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores);
		const dev = await deviceKey();
		const other = 'd'.repeat(64);
		const { mb, store } = makeDo(`acct:${dev.keyHash}`, env, stores);
		store.map.set('balance', 5000);
		const nonce = crypto.randomUUID();
		const auth = await signAuth(dev, dev.keyHash, '/ai/usage', { room: 'R', seconds: 50, account: dev.keyHash }, { nonce });
		expect((await call(mb, `acct:${dev.keyHash}`, '/debit', TOKENS.spend, { amount: 50, room: 'R', auth })).status).toBe(200);
		// replay → dauth:<nonce> consumed
		expect((await call(mb, `acct:${dev.keyHash}`, '/debit', TOKENS.spend, { amount: 50, room: 'R', auth })).status).toBe(401);
		// signed for a different account → rejected
		const cross = await signAuth(dev, other, '/ai/usage', { room: 'R', seconds: 50, account: other });
		expect((await call(mb, `acct:${dev.keyHash}`, '/debit', TOKENS.spend, { amount: 50, room: 'R', auth: cross })).status).toBe(401);
		expect(store.map.get('balance')).toBe(4950);
	});

	it('allows sponsored-room debits bounded per call, rejects non-sponsored', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores);
		const acct = 'e'.repeat(64);
		const { mb, store } = makeDo(`acct:${acct}`, env, stores);
		store.map.set('balance', 9000);
		store.map.set('sponsored:ROOMX', true);
		// non-sponsored room → 401
		expect((await call(mb, `acct:${acct}`, '/debit', TOKENS.spend, { amount: 100, room: 'OTHER' })).status).toBe(401);
		// sponsored room → ok, clamped to the 7200s per-call ceiling
		const res = await call(mb, `acct:${acct}`, '/debit', TOKENS.spend, { amount: 99999, room: 'ROOMX' });
		expect(res.status).toBe(200);
		expect(store.map.get('balance')).toBe(9000 - 7200);
	});

	it('clawback debits only what a recorded credit added', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores);
		const acct = 'f'.repeat(64);
		const { mb, store } = makeDo(`acct:${acct}`, env, stores);
		// refund with no matching credit → 403, nothing moves
		expect((await call(mb, `acct:${acct}`, '/debit', TOKENS.admin, { amount: 100, clawbackOf: 'pi:nope' })).status).toBe(403);
		// record a real credit, then claw back more than it → capped
		await call(mb, `acct:${acct}`, '/credit', TOKENS.admin, { amount: 300, creditId: 'pi_1' });
		expect(store.map.get('balance')).toBe(300);
		const res = await call(mb, `acct:${acct}`, '/debit', TOKENS.admin, { amount: 500, clawbackOf: 'pi_1' });
		expect(res.status).toBe(200);
		expect(res.body.debitedSeconds).toBe(300);
		expect(store.map.get('balance')).toBe(0);
		// a second clawback of the same credit → nothing left to unwind
		expect((await call(mb, `acct:${acct}`, '/debit', TOKENS.admin, { amount: 50, clawbackOf: 'pi_1' })).status).toBe(403);
	});

	it('spend token cannot credit acct:* — only admin can settle', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores);
		const acct = '1'.repeat(64);
		const { mb, store } = makeDo(`acct:${acct}`, env, stores);
		expect((await call(mb, `acct:${acct}`, '/credit', TOKENS.spend, { amount: 100 })).status).toBe(403);
		expect((await call(mb, `acct:${acct}`, '/credit', TOKENS.admin, { amount: 100 })).status).toBe(200);
		expect(store.map.get('balance')).toBe(100);
		expect(store.map.get('credit:pi_9')).toBeUndefined();
	});

	it('transfer moves only the signed amount to the signed room', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores);
		const dev = await deviceKey();
		const { mb, store } = makeDo(`acct:${dev.keyHash}`, env, stores);
		store.map.set('balance', 1000);
		// unsigned transfer attempt → 401
		expect((await call(mb, `acct:${dev.keyHash}`, '/transfer', TOKENS.admin, { to: 'EVIL', amount: 500 })).status).toBe(401);
		// signed convert to ROOM1 of 200; op args claim EVIL/999 — signed wins
		const auth = await signAuth(dev, dev.keyHash, '/pay/convert', { accountId: dev.keyHash, room: 'ROOM1', seconds: 200 });
		const res = await call(mb, `acct:${dev.keyHash}`, '/transfer', TOKENS.admin, { to: 'EVIL', amount: 999, auth });
		expect(res.status).toBe(200);
		expect(store.map.get('balance')).toBe(800);
		expect(stores.get('ROOM1')!.map.get('balance')).toBe(200);
		expect(stores.get('EVIL')).toBeUndefined();
	});

	it('open mode (no METER_ACL) stays permissive for self-hosters', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores, false);
		const acct = '2'.repeat(64);
		const { mb, store } = makeDo(`acct:${acct}`, env, stores);
		store.map.set('balance', 100);
		const res = await call(mb, `acct:${acct}`, '/debit', 'anything', { amount: 40 });
		expect(res.status).toBe(200);
		expect(store.map.get('balance')).toBe(60);
	});

	it('settle role can credit wallets but not sponsor or transfer', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores);
		const acct = '9'.repeat(64);
		const { mb, store } = makeDo(`acct:${acct}`, env, stores);
		expect((await call(mb, `acct:${acct}`, '/credit', TOKENS.settle, { amount: 100, creditId: 'pi_x' })).status).toBe(200);
		expect(store.map.get('balance')).toBe(100);
		// but settle cannot touch an unsigned debit, a sponsor flag, or a transfer
		expect((await call(mb, `acct:${acct}`, '/debit', TOKENS.settle, { amount: 50 })).status).toBe(401);
		const { mb: mbRoom } = makeDo('ROOMS', env, stores);
		expect((await call(mbRoom, 'ROOMS', '/sponsor', TOKENS.settle, { account: acct })).status).toBe(403);
		expect((await call(mb, `acct:${acct}`, '/transfer', TOKENS.settle, { to: 'X', amount: 10 })).status).toBe(403);
	});

	it('kvput on acct:* internal keys is denied for every role', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores);
		const acct = '8'.repeat(64);
		const { mb } = makeDo(`acct:${acct}`, env, stores);
		for (const tok of [TOKENS.admin, TOKENS.settle]) {
			expect((await call(mb, `acct:${acct}`, '/kvput', tok, { key: 'balance', value: 99999 })).status).toBe(403);
			expect((await call(mb, `acct:${acct}`, '/kvput', tok, { key: 'credit:pi_fake', value: 500 })).status).toBe(403);
			expect((await call(mb, `acct:${acct}`, '/kvput', tok, { key: 'nonce:x', value: 0 })).status).toBe(403);
		}
	});

	it('key:* writes require a live link-approve signature bound to the pubkey', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores);
		const owner = await deviceKey();
		const newDev = await deviceKey();
		const { mb, store } = makeDo(`acct:${owner.keyHash}`, env, stores);
		// unsigned injection attempt by the admin token alone → 401
		expect((await call(mb, `acct:${owner.keyHash}`, '/kvput', TOKENS.admin,
			{ key: `key:${newDev.keyHash}`, value: { pub: 'aa' } })).status).toBe(401);
		// signed link-approve carrying the new device's pub → stored w/ binding
		const auth = await signAuth(owner, owner.keyHash, '/pay/link-approve',
			{ accountId: owner.keyHash, code: 'abc', pub: toHex(newDev.pub) });
		expect((await call(mb, `acct:${owner.keyHash}`, '/kvput', TOKENS.admin,
			{ key: `key:${newDev.keyHash}`, value: {}, auth })).status).toBe(200);
		expect((store.map.get(`key:${newDev.keyHash}`) as { pub: string }).pub).toBe(toHex(newDev.pub));
		// signed body that names a DIFFERENT pub → binding fails
		const evil = await deviceKey();
		const bad = await signAuth(owner, owner.keyHash, '/pay/link-approve',
			{ accountId: owner.keyHash, code: 'abc', pub: toHex(evil.pub) });
		expect((await call(mb, `acct:${owner.keyHash}`, '/kvput', TOKENS.admin,
			{ key: `key:${newDev.keyHash}`, value: {}, auth: bad })).status).toBe(403);
	});

	it('sponsored:* writes come from the signed /pay/sponsor body; budget decrements', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores);
		const dev = await deviceKey();
		const { mb, store } = makeDo(`acct:${dev.keyHash}`, env, stores);
		store.map.set('balance', 50000);
		// unsigned sponsor record write → 401
		expect((await call(mb, `acct:${dev.keyHash}`, '/kvput', TOKENS.admin,
			{ key: 'sponsored:RM', value: true })).status).toBe(401);
		// signed sponsor with budgetSeconds 100 → DO derives the record
		const auth = await signAuth(dev, dev.keyHash, '/pay/sponsor',
			{ accountId: dev.keyHash, room: 'RM', on: true, budgetSeconds: 100 });
		expect((await call(mb, `acct:${dev.keyHash}`, '/kvput', TOKENS.admin,
			{ key: 'sponsored:RM', value: true, auth })).status).toBe(200);
		const rec = store.map.get('sponsored:RM') as { budget: number; spent: number };
		expect(rec.budget).toBe(100);
		// spend against it — bounded by the 100s budget, not just the call cap
		const d1 = await call(mb, `acct:${dev.keyHash}`, '/debit', TOKENS.spend, { amount: 7200, room: 'RM' });
		expect(d1.status).toBe(200);
		expect(d1.body.debitedSeconds).toBe(100);
		// budget exhausted → next debit fails 402 even though wallet has funds
		expect((await call(mb, `acct:${dev.keyHash}`, '/debit', TOKENS.spend, { amount: 50, room: 'RM' })).status).toBe(402);
		expect(store.map.get('balance')).toBe(50000 - 100);
	});

	it('cust:* accountId is first-binding even for settle', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores);
		const { mb } = makeDo('cust:cus_1', env, stores);
		expect((await call(mb, 'cust:cus_1', '/kvput', TOKENS.settle, { key: 'accountId', value: 'aaaa' })).status).toBe(200);
		expect((await call(mb, 'cust:cus_1', '/kvput', TOKENS.settle, { key: 'accountId', value: 'bbbb' })).status).toBe(409);
	});

	it('passkey signCount bumps pass without auth; new enrollments need it', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores);
		const acct = '7'.repeat(64);
		const { mb, store } = makeDo(`acct:${acct}`, env, stores);
		// bump-only update on an existing credential → allowed
		expect((await call(mb, `acct:${acct}`, '/kvput', TOKENS.admin,
			{ key: 'passkey:c1', value: { pubSpki: 'aa', signCount: 0 } })).status).toBe(401); // no existing → auth needed
		store.map.set('passkey:c1', { pubSpki: 'aa', signCount: 1 });
		expect((await call(mb, `acct:${acct}`, '/kvput', TOKENS.admin,
			{ key: 'passkey:c1', value: { pubSpki: 'aa', signCount: 2 } })).status).toBe(200);
		// pubkey swap under the same credId → not a bump, needs a signature
		expect((await call(mb, `acct:${acct}`, '/kvput', TOKENS.admin,
			{ key: 'passkey:c1', value: { pubSpki: 'bb', signCount: 3 } })).status).toBe(401);
	});

	it('writes a server-side audit entry for acct money ops', async () => {
		const stores = new Map<string, ReturnType<typeof fakeStorage>>();
		const env = await makeEnv(stores);
		const dev = await deviceKey();
		const { mb, store } = makeDo(`acct:${dev.keyHash}`, env, stores);
		store.map.set('balance', 500);
		const auth = await signAuth(dev, dev.keyHash, '/ai/usage', { room: 'R', seconds: 30, account: dev.keyHash });
		await call(mb, `acct:${dev.keyHash}`, '/debit', TOKENS.spend, { amount: 30, room: 'R', auth });
		const audit = store.map.get('audit') as { op: string; via: string; amount: number }[];
		expect(audit[0].op).toBe('debit');
		expect(audit[0].amount).toBe(30);
		expect(audit[0].via).toBe(`key:${dev.keyHash.slice(0, 8)}`);
	});
});
