import { describe, it, expect } from 'vitest';
import { onRequest } from './[[path]]';

const SECRET = 'test-hmac-secret';
const ADMIN = 'test-admin-token';

// ------------------------------------------------------------------ fakes
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
	async list(opts: { prefix?: string; cursor?: string; limit?: number; delimiter?: string }) {
		const keys = [...this.store.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort();
		if (opts.delimiter) {
			const prefixes = new Set<string>();
			for (const k of keys) {
				const rest = k.slice((opts.prefix ?? '').length);
				const i = rest.indexOf(opts.delimiter);
				prefixes.add(i >= 0 ? (opts.prefix ?? '') + rest.slice(0, i + 1) : (opts.prefix ?? '') + rest);
			}
			return { objects: [], delimitedPrefixes: [...prefixes], truncated: false, cursor: undefined } as unknown as R2Objects;
		}
		return {
			objects: keys.map((k) => ({ key: k })),
			delimitedPrefixes: [],
			truncated: false,
			cursor: undefined
		} as unknown as R2Objects;
	}
}
class FakeAE {
	points: { blobs: string[]; doubles: number[]; indexes: string[] }[] = [];
	writeDataPoint(p: { blobs: string[]; doubles: number[]; indexes: string[] }) {
		this.points.push(p);
	}
}

function env(over: Record<string, unknown> = {}) {
	return { UX_HMAC: SECRET, UX_ADMIN: ADMIN, UX_REPLAY: new FakeR2(), UX_EVENTS: new FakeAE(), ...over };
}
function call(path: string, init: RequestInit, e: ReturnType<typeof env>, url = `https://x.test/api/ux/${path}`) {
	return onRequest({ request: new Request(url, init), env: e } as Parameters<typeof onRequest>[0]);
}
const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/json', ...headers },
	body: JSON.stringify(body)
});

async function session(e: ReturnType<typeof env>, headers: Record<string, string> = {}) {
	const r = await call('session', { method: 'POST', headers }, e);
	expect(r.status).toBe(200);
	return (await r.json()) as { token: string; visitId: string; exp: number };
}
const ev = (visitId: string, over: Record<string, unknown> = {}) => ({
	v: 1, detector: 1, visitId, eventId: `${visitId}:1`, seq: 1, at: Date.now(),
	page: 'room', event: 'activation', release: 'dev', device: 'desktop',
	browser: 'Chrome', browserMajor: 140, role: 'host', target: 'settings', actionId: 1,
	...over
});

// ------------------------------------------------------------------- tests
describe('session mint', () => {
	it('mints a signed token bound to a fresh visitId', async () => {
		const e = env();
		const s = await session(e);
		expect(s.token.split('.')).toHaveLength(3);
		expect(s.visitId).toMatch(/^[0-9a-f-]{36}$/);
		expect(s.exp).toBeGreaterThan(Date.now() / 1000);
	});
	it('refuses under GPC/DNT and when the secret is absent', async () => {
		const e = env();
		expect((await call('session', { method: 'POST', headers: { 'sec-gpc': '1' } }, e)).status).toBe(204);
		expect((await call('session', { method: 'POST', headers: { dnt: '1' } }, e)).status).toBe(204);
		expect((await call('session', { method: 'POST' }, env({ UX_HMAC: undefined }))).status).toBe(503);
	});
});

describe('events', () => {
	it('writes conforming events to Analytics Engine', async () => {
		const e = env();
		const s = await session(e);
		const r = await call('events', post({ token: s.token, events: [ev(s.visitId), ev(s.visitId, { seq: 2, event: 'step', step: 'join_succeeded', target: undefined })] }), e);
		expect(r.status).toBe(200);
		expect(((await r.json()) as { accepted: number }).accepted).toBe(2);
		const ae = e.UX_EVENTS as FakeAE;
		expect(ae.points).toHaveLength(2);
		expect(ae.points[0].blobs[0]).toBe('activation');
		expect(ae.points[0].blobs[9]).toBe(s.visitId);
	});

	it('drops non-conforming / foreign-visit / free-text events', async () => {
		const e = env();
		const s = await session(e);
		const bad = [
			ev('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), // foreign visitId
			ev(s.visitId, { event: 'arbitrary_name' }),
			ev(s.visitId, { target: 'free text here' }),
			ev(s.visitId, { page: '/room/803351' }),
			ev(s.visitId, { name: 'Ada' }) // extra field is dropped silently (event still valid)
		];
		const r = await call('events', post({ token: s.token, events: bad }), e);
		expect(((await r.json()) as { accepted: number }).accepted).toBe(1);
		const ae = e.UX_EVENTS as FakeAE;
		expect(ae.points).toHaveLength(1);
		expect(JSON.stringify(ae.points[0])).not.toContain('Ada');
	});

	it('rejects bad tokens and oversized payloads', async () => {
		const e = env();
		const s = await session(e);
		expect((await call('events', post({ token: 'v1.bogus.sig', events: [] }), e)).status).toBe(400);
		expect((await call('events', post({ token: s.token, events: Array.from({ length: 41 }, (_, i) => ev(s.visitId, { seq: i })) }), e)).status).toBe(400);
	});

	it('privacy signal suppresses event ingestion entirely', async () => {
		const e = env();
		const s = await session(e);
		const r = await call('events', post({ token: s.token, events: [ev(s.visitId)] }, { dnt: '1' }), e);
		expect(r.status).toBe(204);
		expect((e.UX_EVENTS as FakeAE).points).toHaveLength(0);
	});
});

describe('replay chunks', () => {
	it('stores a masked chunk under the visit prefix', async () => {
		const e = env();
		const s = await session(e);
		const r = await call(
			'replay/chunks',
			post({ token: s.token, visitId: s.visitId, chunkIndex: 0, events: [{ type: 2, timestamp: 1, data: { node: {} } }] }),
			e
		);
		expect(r.status).toBe(200);
		expect([...(e.UX_REPLAY as FakeR2).store.keys()]).toEqual([`ux-replay/${s.visitId}/chunk-0000`]);
	});

	it('rejects foreign visits, bad indexes and non-event payloads', async () => {
		const e = env();
		const s = await session(e);
		const r2 = e.UX_REPLAY as FakeR2;
		const cases = [
			{ token: s.token, visitId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', chunkIndex: 0, events: [{ type: 2 }] },
			{ token: s.token, visitId: s.visitId, chunkIndex: -1, events: [{ type: 2 }] },
			{ token: s.token, visitId: s.visitId, chunkIndex: 64, events: [{ type: 2 }] },
			{ token: s.token, visitId: s.visitId, chunkIndex: 0, events: [{ type: 9 }] },
			{ token: s.token, visitId: s.visitId, chunkIndex: 0, events: ['raw text'] },
			{ token: s.token, visitId: '../../etc', chunkIndex: 0, events: [{ type: 2 }] }
		];
		for (const c of cases) expect((await call('replay/chunks', post(c), e)).status).toBe(400);
		expect(r2.store.size).toBe(0);
	});

	it('close writes a _meta marker with a valid status', async () => {
		const e = env();
		const s = await session(e);
		expect((await call('replay/close', post({ token: s.token, visitId: s.visitId, status: 'completed' }), e)).status).toBe(200);
		expect((await call('replay/close', post({ token: s.token, visitId: s.visitId, status: 'bogus' }), e)).status).toBe(400);
		expect((e.UX_REPLAY as FakeR2).store.get(`ux-replay/${s.visitId}/_meta`)).toContain('completed');
	});
});

describe('revoke', () => {
	it('deletes every object under the visit prefix, indistinguishable response', async () => {
		const e = env();
		const s = await session(e);
		await call('replay/chunks', post({ token: s.token, visitId: s.visitId, chunkIndex: 0, events: [{ type: 2 }] }), e);
		await call('replay/chunks', post({ token: s.token, visitId: s.visitId, chunkIndex: 1, events: [{ type: 3 }] }), e);
		await call('replay/close', post({ token: s.token, visitId: s.visitId, status: 'completed' }), e);
		expect((e.UX_REPLAY as FakeR2).store.size).toBe(3);
		const r = await call('revoke', post({ token: s.token }), e);
		expect(r.status).toBe(204);
		expect((e.UX_REPLAY as FakeR2).store.size).toBe(0);
		// unknown token → same 204, no oracle
		expect((await call('revoke', post({ token: 'v1.bogus.sig' }), e)).status).toBe(204);
	});
});

describe('admin replay access', () => {
	it('denies unauthenticated requests', async () => {
		const e = env();
		expect((await call('admin/replay/sessions', { method: 'GET' }, e)).status).toBe(403);
		expect((await call('admin/replay/chunk?visit=x&index=0', { method: 'GET', headers: { authorization: 'Bearer wrong' } }, e, 'https://x.test/api/ux/admin/replay/chunk?visit=x&index=0')).status).toBe(403);
	});

	it('lists sessions and serves chunks with the admin token', async () => {
		const e = env();
		const s = await session(e);
		await call('replay/chunks', post({ token: s.token, visitId: s.visitId, chunkIndex: 0, events: [{ type: 2, timestamp: 1 }] }), e);
		await call('replay/close', post({ token: s.token, visitId: s.visitId, status: 'completed' }), e);
		const auth = { authorization: `Bearer ${ADMIN}` };
		const list = await call('admin/replay/sessions', { method: 'GET', headers: auth }, e);
		const sessions = ((await list.json()) as { sessions: { visit: string; status: string }[] }).sessions;
		expect(sessions).toEqual([{ visit: s.visitId, status: 'completed', closedAt: expect.any(Number) }]);
		const chunk = await call(
			'admin/replay/chunk',
			{ method: 'GET', headers: auth },
			e,
			`https://x.test/api/ux/admin/replay/chunk?visit=${s.visitId}&index=0`
		);
		expect(await chunk.json()).toEqual([{ type: 2, timestamp: 1 }]);
	});
});
