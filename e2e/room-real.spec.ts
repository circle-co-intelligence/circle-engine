import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test';

/**
 * Real-room convergence tests — two live browser contexts joined to the
 * same circle over the real P2P mesh. Exercises engine lanes that unit
 * tests can't reach: signed-op replication, consent, erasure, question
 * moments, policy denials, authority takeover, and the HLS witness seat.
 *
 * Seams (install.ts): __cicDebug(code) → session.debugView(); __cicSession
 * (code) → live RoomSession for method calls — the same objects the bridge
 * drives, so assertions observe real apply/broadcast behavior.
 */

const newCode = () => String(Math.floor(100000 + Math.random() * 900000));

async function join(browser: Browser, name: string, code: string) {
	const ctx: BrowserContext = await browser.newContext({
		permissions: ['camera', 'microphone']
	});
	const p = await ctx.newPage();
	await p.goto(`/room/${code}`);
	await p.getByPlaceholder('Your name').fill(name);
	await p.getByRole('button', { name: 'Join circle' }).click();
	return { ctx, p };
}

type Debug = {
	self: string;
	auth: string | null;
	peers: string[];
	epoch: number;
	opCount: number;
	stick: { state: string; holder: string | null; atSeatOf: string | null; resumeTo: string | null };
	consents: Record<string, string>;
	recording: boolean;
	recordingStartedBy: string | null;
	isoRunning: boolean;
	chatLog: string[];
	captions: string[];
	streamKeys: string[];
	streamHls: string | null;
	selfMuted: boolean;
	mode: string;
};

const dbg = (p: Page, code: string) =>
	p.evaluate(
		(c) => (window as unknown as { __cicDebug: (c: string) => Debug }).__cicDebug(c),
		code
	);

const call = (p: Page, code: string, method: string, ...args: unknown[]) =>
	p.evaluate(
		([c, m, a]) => {
			const s = (window as unknown as {
				__cicSession: (c: string) => Record<string, (...x: unknown[]) => unknown>;
			}).__cicSession(c);
			return s[m](...(a as unknown[]));
		},
		[code, method, args] as const
	);

/** wait until both replicas see each other seated */
async function pairSeated(a: Page, b: Page, code: string) {
	for (const p of [a, b])
		await expect
			.poll(async () => (await dbg(p, code)).peers.length, { timeout: 60_000 })
			.toBe(1);
}

test.describe.serial('real two-peer room', () => {
	test('stick: request/pass/question converge identically on both replicas', async ({ browser }) => {
		const code = newCode();
		const A = await join(browser, 'Ada', code);
		const B = await join(browser, 'Grace', code);
		await pairSeated(A.p, B.p, code);
		const idA = (await dbg(A.p, code)).self;
		const idB = (await dbg(B.p, code)).self;

		// A takes the stick — holder converges on both
		await call(A.p, code, 'requestStick');
		for (const p of [A.p, B.p])
			await expect.poll(async () => (await dbg(p, code)).stick.holder, { timeout: 15_000 }).toBe(idA);

		// circle_round pass → forced to next seat (B) on both replicas
		await call(A.p, code, 'passStick');
		for (const p of [A.p, B.p])
			await expect.poll(async () => (await dbg(p, code)).stick.holder, { timeout: 15_000 }).toBe(idB);

		// A asks the holder a question → question moment, asker at floor,
		// stick reserved for B
		await call(A.p, code, 'askQuestion');
		await expect.poll(async () => (await dbg(B.p, code)).stick.state, { timeout: 15_000 }).toBe('question');
		const qA = await dbg(A.p, code);
		expect(qA.stick.atSeatOf).toBe(idA);
		expect(qA.stick.resumeTo).toBe(idB);

		// B (holder) ends it → floor returns to B on both
		await call(B.p, code, 'endQuestion');
		for (const p of [A.p, B.p])
			await expect
				.poll(async () => {
					const d = await dbg(p, code);
					return `${d.stick.state}:${d.stick.holder}`;
				}, { timeout: 15_000 })
				.toBe(`held:${idB}`);

		await A.ctx.close();
		await B.ctx.close();
	});

	test('consent op replicates; denial excludes but never blocks the record', async ({ browser }) => {
		const code = newCode();
		const A = await join(browser, 'Ada', code);
		const B = await join(browser, 'Grace', code);
		await pairSeated(A.p, B.p, code);
		const idB = (await dbg(B.p, code)).self;

		// A proposes recording → B sees A's signed consent grant in the map
		await call(A.p, code, 'proposeRecording');
		const idA = (await dbg(A.p, code)).self;
		await expect
			.poll(async () => (await dbg(B.p, code)).consents[idA], { timeout: 15_000 })
			.toBe('granted');

		// B denies → the denial op converges on A (self-attributed, durable)
		await call(B.p, code, 'answerConsent', false);
		await expect
			.poll(async () => (await dbg(A.p, code)).consents[idB], { timeout: 15_000 })
			.toBe('denied');

		// recording STILL starts — exclusion model: the denier is absent from
		// the record, not a veto on the room
		for (const p of [A.p, B.p])
			await expect.poll(async () => (await dbg(p, code)).recording, { timeout: 20_000 }).toBe(true);
		expect((await dbg(A.p, code)).recordingStartedBy).toBe(idA);
		// B never consented → its own ISO pipeline stays cold (fail-closed)
		expect((await dbg(B.p, code)).isoRunning).toBe(false);

		await call(A.p, code, 'stopRecording');
		await expect.poll(async () => (await dbg(B.p, code)).recording, { timeout: 15_000 }).toBe(false);

		await A.ctx.close();
		await B.ctx.close();
	});

	test('erasure purges contributions on every replica', async ({ browser }) => {
		const code = newCode();
		const A = await join(browser, 'Ada', code);
		const B = await join(browser, 'Grace', code);
		await pairSeated(A.p, B.p, code);

		// B's chat converges on A
		await call(B.p, code, 'sendChat', 'hello circle');
		await expect
			.poll(async () => (await dbg(A.p, code)).chatLog.length, { timeout: 15_000 })
			.toBeGreaterThan(0);

		// B self-erases → the op purges the contribution on BOTH replicas
		await call(B.p, code, 'eraseSelf');
		for (const p of [A.p, B.p])
			await expect
				.poll(async () => (await dbg(p, code)).chatLog.filter((l) => l.includes('hello circle')).length, {
					timeout: 15_000
				})
				.toBe(0);

		await A.ctx.close();
		await B.ctx.close();
	});

	test('policy holds in the live room: mode-set denied for non-manager, remote unmute impossible', async ({
		browser
	}) => {
		const code = newCode();
		const A = await join(browser, 'Ada', code);
		const B = await join(browser, 'Grace', code);
		await pairSeated(A.p, B.p, code);

		// identify the authority — whoever it is, the OTHER page is a member
		const dA = await dbg(A.p, code);
		const member = dA.auth === dA.self ? B : A;

		// member tries to flip the mode — denied at emit (self-apply through
		// policy), so it never leaves their client
		const before = (await dbg(member.p, code)).mode;
		await call(member.p, code, 'setMode', 'open_round');
		await member.p.waitForTimeout(1500);
		expect((await dbg(member.p, code)).mode).toBe(before);

		// remote unmute is denied unconditionally — even the authority cannot
		// open a member's mic
		const keeper = dA.auth === dA.self ? A : B;
		const memberId = (await dbg(member.p, code)).self;
		const mutedBefore = (await dbg(member.p, code)).selfMuted;
		await keeper.p.evaluate(
			([c, id]) => {
				const s = (window as unknown as {
					__cicSession: (c: string) => { emitOp: (op: unknown) => void };
				}).__cicSession(c);
				s.emitOp({ t: 'mute-set', id, kind: 'audio', on: false });
			},
			[code, memberId] as const
		);
		await member.p.waitForTimeout(1500);
		expect((await dbg(member.p, code)).selfMuted).toBe(mutedBefore);

		await A.ctx.close();
		await B.ctx.close();
	});

	test('authority takeover: killing the keeper promotes the survivor', async ({ browser }) => {
		const code = newCode();
		const A = await join(browser, 'Ada', code);
		const B = await join(browser, 'Grace', code);
		await pairSeated(A.p, B.p, code);

		const dA = await dbg(A.p, code);
		const keeper = dA.auth === dA.self ? A : B;
		const survivor = dA.auth === dA.self ? B : A;
		const survivorId = (await dbg(survivor.p, code)).self;

		// kill the keeper's whole context — tab, renderer, and heartbeat
		await keeper.ctx.close();

		// keeper's departure recomputes the electorate — survivor becomes
		// authority (epoch advance is only for a frozen-but-CONNECTED regime;
		// a clean leave needs no fence — the old authority can emit nothing)
		await expect
			.poll(async () => (await dbg(survivor.p, code)).auth, { timeout: 45_000 })
			.toBe(survivorId);

		// ops still validate and apply under the new regime
		const before = (await dbg(survivor.p, code)).opCount;
		await call(survivor.p, code, 'requestStick');
		await expect.poll(async () => (await dbg(survivor.p, code)).stick.holder).toBe(survivorId);
		expect((await dbg(survivor.p, code)).opCount).toBeGreaterThan(before);

		await survivor.ctx.close();
	});

	test('HLS witness: manifest announcement creates a live-stream seat on both replicas', async ({
		browser
	}) => {
		const code = newCode();
		const A = await join(browser, 'Ada', code);
		const B = await join(browser, 'Grace', code);
		await pairSeated(A.p, B.p, code);

		const dA = await dbg(A.p, code);
		const keeper = dA.auth === dA.self ? A : B;
		const witness = dA.auth === dA.self ? B : A;

		// keeper announces a stream — witness attaches HLS → captureStream
		// surfaces as a live-stream remote stream
		await call(keeper.p, code, 'announceStream', 'https://example.test/live/index.m3u8');
		for (const p of [keeper.p, witness.p]) {
			await expect
				.poll(async () => (await dbg(p, code)).streamHls, { timeout: 15_000 })
				.toBe('https://example.test/live/index.m3u8');
			await expect
				.poll(async () => (await dbg(p, code)).streamKeys, { timeout: 15_000 })
				.toContain('live-stream');
		}

		await A.ctx.close();
		await B.ctx.close();
	});
});
