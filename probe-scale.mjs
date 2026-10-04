import { chromium } from '@playwright/test';

// Scale sanity: N speakers + W witnesses in one room.
// speakers: full participants (publish+receive). witnesses: ?witness=1
// receive-only audience seats — never publish, never ISO-recorded.
const N = Number(process.env.PROBE_N ?? 6);
const W = Number(process.env.PROBE_W ?? 9);
const CODE = process.env.PROBE_CODE ?? String(Math.floor(100000 + Math.random() * 900000));
const BASE = process.env.PROBE_BASE ?? 'https://circle-engine-7ny.pages.dev';
const TOTAL = N + W;
console.log(`${N} speakers + ${W} witnesses → ${BASE}/room/${CODE}`);

const browser = await chromium.launch({
	channel: 'chromium',
	args: [
		'--use-fake-ui-for-media-stream',
		'--use-fake-device-for-media-stream',
		`--use-file-for-fake-audio-capture=${process.env.HOME}/.cache/cic-probe/speech16_loop.wav`,
		'--autoplay-policy=no-user-gesture-required'
	]
});

const joinAs = async (name, witness = false) => {
	const p = await (await browser.newContext({ permissions: ['microphone', 'camera'] })).newPage();
	await p.goto(`${BASE}/room/${CODE}${witness ? '?witness=1' : ''}`);
	const inp = p.locator('input').first();
	await inp.waitFor({ state: 'visible', timeout: 60000 });
	await inp.fill(name);
	await p.click('button:has-text("Join circle")');
	return p;
};

const speakers = [];
const witnesses = [];
for (let i = 0; i < N; i++) {
	const p = await joinAs(`S${i}`);
	p.on('pageerror', (e) => console.log(`  [s${i} err]`, e.message.slice(0, 140)));
	speakers.push(p);
	await p.waitForTimeout(900);
}
for (let i = 0; i < W; i++) {
	const p = await joinAs(`W${i}`, true);
	p.on('pageerror', (e) => console.log(`  [w${i} err]`, e.message.slice(0, 140)));
	witnesses.push(p);
	await p.waitForTimeout(600);
}
console.log('all joined — unmuting speakers…');
await speakers[0].waitForTimeout(6000);

// unmute every speaker (retry until the button mounts — headless render lag)
for (const [i, p] of speakers.entries()) {
	for (let a = 0; a < 6; a++) {
		const hit = await p.evaluate(() => {
			const el = document.querySelector('[aria-label="Unmute mic"], [aria-label="Your microphone is muted"]');
			if (el) { el.click(); return true; }
			return !!document.querySelector('[aria-label="Mute mic"]');
		});
		if (hit) break;
		await p.waitForTimeout(1500);
	}
}
console.log('negotiating media…');
await speakers[0].waitForTimeout(35000);

const dump = async (p, tag) => {
	const d = await p.evaluate((c) => window.__cicDebug?.(c) ?? null, CODE);
	if (!d) {
		// why did the session never register — still on prejoin, or boot failed?
		const state = await p.evaluate(() => ({
			url: location.pathname + location.search,
			hasInput: !!document.querySelector('input'),
			bodyText: (document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)
		}));
		console.log(`  ${tag}: no session — ${JSON.stringify(state)}`);
	}
	const rem = d?.media?.remote ?? {};
	const live = Object.values(rem).reduce((n, ts) => n + ts.filter((t) => t.endsWith(':live')).length, 0);
	return {
		tag,
		peers: d ? d.peers?.length ?? -1 : -2,
		feeds: Object.keys(rem).length,
		live,
		local: d?.media?.local?.length ?? 0
	};
};

let allOk = true;
for (const [i, p] of speakers.entries()) {
	const r = await dump(p, `s${i}`);
	// speakers see all participants; remote feeds only from publishers
	const ok = r.peers === TOTAL - 1 && r.feeds >= N - 1;
	if (!ok) allOk = false;
	console.log(`  s${i}: peers=${r.peers} remoteFeeds=${r.feeds} liveTracks=${r.live} localTracks=${r.local}${ok ? '' : '  ← MISS'}`);
}
for (const [i, p] of witnesses.entries()) {
	const r = await dump(p, `w${i}`);
	// witnesses see everyone, pull every speaker's feeds, publish nothing
	const ok = r.peers === TOTAL - 1 && r.feeds >= N && r.local === 0;
	if (!ok) allOk = false;
	console.log(`  w${i}: peers=${r.peers} remoteFeeds=${r.feeds} liveTracks=${r.live} localTracks=${r.local}${ok ? '' : '  ← MISS'}`);
}

// zombie check: hard-close two speakers, survivors must drop them
console.log('killing s0+s1 — waiting for leave propagation…');
const victims = [speakers[0], speakers[1]];
await Promise.all(victims.map((p) => p.context().close()));
await speakers[2].waitForTimeout(90000);
const after = await dump(speakers[2], 's2');
console.log(`  s2 peers after kill: ${after.peers} (was ${TOTAL - 1}, expect ≤ ${TOTAL - 3})`);
const zombieOk = after.peers <= TOTAL - 3;

console.log(allOk && zombieOk ? `PASS — ${TOTAL} participants, zombies reaped` : `PARTIAL — peerMesh=${allOk} zombieReap=${zombieOk}`);
await browser.close();
process.exit(allOk && zombieOk ? 0 : 1);
