import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../ai/translate', () => ({
	translateText: vi.fn(async (text: string, lang: string) => `${lang}:${text}`),
	WLLAMA_WASM: {}
}));
vi.mock('../ai/speech', () => ({
	CaptionPipeline: class {
		async init() { return false; }
		push() {}
		dispose() {}
	},
	LocalTts: class {
		async init() { return false; }
		async speak() { return null; }
	}
}));
vi.mock('./localSocket', () => ({
	LocalSocket: class {
		open() {}
		send() {}
		protected onClose() {}
	}
}));

import { TranslationFanout } from './stt';

interface FakeSession {
	peerLangs: Record<string, string[]>;
	selfLangs: string[];
	selfLang: string;
	selfId: string;
	sent: { peerId: string; payload: Record<string, unknown> }[];
	watchTrTargets(fn: () => void): () => void;
	fire(): void;
	sendTrSegment(peerId: string, payload: Record<string, unknown>): void;
}

function fakeSession() {
	const watchers = new Set<() => void>();
	const s: FakeSession = {
		peerLangs: {},
		selfLangs: [],
		selfLang: 'en',
		selfId: 'self',
		sent: [],
		watchTrTargets(fn) {
			watchers.add(fn);
			return () => watchers.delete(fn);
		},
		fire() { watchers.forEach((f) => f()); },
		sendTrSegment(peerId, payload) { this.sent.push({ peerId, payload }); }
	};
	return s;
}

const sink = { frame: vi.fn() };
const flush = () => new Promise((r) => setTimeout(r, 20));

describe('TranslationFanout replay', () => {
	beforeEach(() => sink.frame.mockClear());

	it('replays buffered finals to a lane declared after the segment', async () => {
		const s = fakeSession();
		const f = new TranslationFanout(s as never, sink);
		// segment lands before anyone subscribes — dropped at emit time
		f.emit({ text: 'hello there', final: true }, 'g1', 'srcMesh', 'srcProd');
		await flush();
		expect(s.sent).toHaveLength(0);
		// subscriber declares es — watcher fires → backlog replays to them
		s.peerLangs = { peer1: ['es'] };
		s.fire();
		await flush();
		expect(s.sent).toHaveLength(1);
		expect(s.sent[0].peerId).toBe('peer1');
		expect(s.sent[0].payload).toMatchObject({ lang: 'es', which: 'final', delta: 'es:hello there', original: 'hello there' });
	});

	it('does not re-replay on an unchanged subscription set', async () => {
		const s = fakeSession();
		const f = new TranslationFanout(s as never, sink);
		f.emit({ text: 'one', final: true }, 'g1', 'm', 'p');
		s.peerLangs = { peer1: ['es'] };
		s.fire();
		await flush();
		s.fire(); // same state — a second notify must not resend
		await flush();
		expect(s.sent).toHaveLength(1);
	});

	it('delivers new segments live to an existing lane', async () => {
		const s = fakeSession();
		s.peerLangs = { peer1: ['fr'] };
		const f = new TranslationFanout(s as never, sink);
		s.fire(); // register lane before any segments
		f.emit({ text: 'live words', final: true }, 'g1', 'm', 'p');
		await flush();
		expect(s.sent).toHaveLength(1);
		expect(s.sent[0].payload).toMatchObject({ lang: 'fr', delta: 'fr:live words' });
	});

	it('replays to a rejoining peer (lane pruned on leave)', async () => {
		const s = fakeSession();
		const f = new TranslationFanout(s as never, sink);
		s.peerLangs = { peer1: ['es'] };
		s.fire();
		f.emit({ text: 'first', final: true }, 'g1', 'm', 'p');
		await flush();
		expect(s.sent).toHaveLength(1);
		// peer leaves → lane pruned; rejoins with same langs → counts as new
		delete s.peerLangs.peer1;
		s.fire();
		s.peerLangs = { peer1: ['es'] };
		s.fire();
		await flush();
		expect(s.sent).toHaveLength(2);
	});

	it('targets only the newly-added lane, not existing subscribers', async () => {
		const s = fakeSession();
		s.peerLangs = { peer1: ['es'] };
		const f = new TranslationFanout(s as never, sink);
		s.fire();
		f.emit({ text: 'while peer1 listens', final: true }, 'g1', 'm', 'p');
		await flush();
		expect(s.sent).toHaveLength(1);
		// a second subscriber joins mid-stream — replay goes ONLY to peer2
		s.peerLangs = { peer1: ['es'], peer2: ['de'] };
		s.fire();
		await flush();
		const replays = s.sent.slice(1);
		expect(replays.length).toBeGreaterThan(0);
		for (const r of replays) expect(r.peerId).toBe('peer2');
		expect(replays[0].payload).toMatchObject({ lang: 'de', delta: 'de:while peer1 listens' });
	});

	it('self-subscription sinks tr-caption locally', async () => {
		const s = fakeSession();
		const f = new TranslationFanout(s as never, sink);
		f.emit({ text: 'my words', final: true }, 'g1', 'm', 'p');
		s.selfLangs = ['es'];
		s.fire();
		await flush();
		const tr = sink.frame.mock.calls.find((c) => (c[0] as { t: string }).t === 'tr-caption');
		expect(tr?.[0]).toMatchObject({ t: 'tr-caption', lang: 'es', delta: 'es:my words' });
	});
});
