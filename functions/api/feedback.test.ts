import { describe, it, expect } from 'vitest';
import { onRequestPost, onRequestGet } from './feedback';

const ADMIN = 'test-admin-token';

class FakeR2 {
	store = new Map<string, string>();
	async put(key: string, v: string) {
		this.store.set(key, v);
		return {} as R2Object;
	}
	async get(key: string) {
		const v = this.store.get(key);
		return v === undefined ? null : ({ body: v, json: async () => JSON.parse(v) } as unknown as R2ObjectBody);
	}
	async delete(key: string) {
		this.store.delete(key);
	}
	async list(opts: { prefix?: string; cursor?: string; limit?: number }) {
		const keys = [...this.store.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort();
		return {
			objects: keys.map((k) => ({ key: k })),
			delimitedPrefixes: [],
			truncated: false,
			cursor: undefined
		} as unknown as R2Objects;
	}
}

const env = () => ({ UX_REPLAY: new FakeR2(), UX_ADMIN: ADMIN });
const req = (body: unknown): Request =>
	new Request('https://x.test/api/feedback', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
const good = (over: Record<string, unknown> = {}) => ({
	sessionId: 'local-803351',
	roomCode: '803351',
	permit: 'a2172370-14af-4252-8503-ab409e55b9a3',
	rating: 4,
	text: 'great circle',
	...over
});

describe('POST /api/feedback', () => {
	it('stores a valid submission under the room/session prefix', async () => {
		const e = env();
		const r = await onRequestPost({ request: req(good()), env: e } as Parameters<typeof onRequestPost>[0]);
		expect(r.status).toBe(200);
		const keys = [...(e.UX_REPLAY as FakeR2).store.keys()];
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatch(/^feedback\/803351\/local-803351\/a2172370-\d+$/);
		const stored = JSON.parse((e.UX_REPLAY as FakeR2).store.get(keys[0])!);
		expect(stored.rating).toBe(4);
		expect(stored.text).toBe('great circle');
	});

	it('rejects malformed bodies', async () => {
		const e = env();
		const cases = [
			good({ sessionId: '../../etc' }),
			good({ roomCode: 'not-digits' }),
			good({ permit: 'true' }), // boolean-as-string is not a credential
			good({ rating: 0 }),
			good({ rating: 6 }),
			good({ rating: 4.5 }),
			good({ text: 42 })
		];
		for (const c of cases)
			expect((await onRequestPost({ request: req(c), env: e } as Parameters<typeof onRequestPost>[0])).status).toBe(400);
		expect((e.UX_REPLAY as FakeR2).store.size).toBe(0);
	});

	it('truncates over-length text at 1200 chars', async () => {
		const e = env();
		await onRequestPost({ request: req(good({ text: 'x'.repeat(5000) })), env: e } as Parameters<typeof onRequestPost>[0]);
		const stored = JSON.parse([...(e.UX_REPLAY as FakeR2).store.values()][0]);
		expect(stored.text).toHaveLength(1200);
	});
});

describe('GET /api/feedback (admin)', () => {
	it('denies unauthenticated and serves submissions to the admin token', async () => {
		const e = env();
		const anon = new Request('https://x.test/api/feedback');
		expect((await onRequestGet({ request: anon, env: e } as Parameters<typeof onRequestGet>[0])).status).toBe(403);
		await onRequestPost({ request: req(good()), env: e } as Parameters<typeof onRequestPost>[0]);
		const auth = new Request('https://x.test/api/feedback', { headers: { authorization: `Bearer ${ADMIN}` } });
		const r = await onRequestGet({ request: auth, env: e } as Parameters<typeof onRequestGet>[0]);
		const body = (await r.json()) as { items: { rating: number }[] };
		expect(body.items).toHaveLength(1);
		expect(body.items[0].rating).toBe(4);
	});
});
