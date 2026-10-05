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
	await p.addInitScript(() => {
		window.__srdFails = 0;
		const o = RTCPeerConnection.prototype.setRemoteDescription;
		RTCPeerConnection.prototype.setRemoteDescription = function (d) {
			return o.call(this, d).catch((e) => {
				window.__srdFails++;
				console.log(`[srd-fail] ${e.message.slice(0, 140)}`);
				throw e;
			});
		};
	});
	p.on('console', (m) => { if (/srd-fail/.test(m.text())) console.log(`  [${name}]`, m.text().slice(0, 160)); });
	const url = `${BASE}/room/${CODE}${witness ? '?witness=1' : ''}`;
	for (let a = 0; a < 4; a++) {
		try {
			await p.goto(url, { timeout: 90000 });
			break;
		} catch (e) {
			if (a === 3) throw e;
			console.log(`  [${name}] goto retry ${a + 1}: ${e.message.slice(0, 80)}`);
			await p.waitForTimeout(3000);
		}
	}
	const inp = p.locator('input').first();
	// boot can stall under heavy parallel load — one reload, then give up
	// (capacity probe: report who made it rather than aborting the run)
	for (let a = 0; a < 2; a++) {
		try {
			await inp.waitFor({ state: 'visible', timeout: 120000 });
			break;
		} catch {
			if (a === 1) {
				console.log(`  [${name}] BOOT-FAIL — never mounted`);
				return null;
			}
			console.log(`  [${name}] boot stall — reloading`);
			await p.reload({ timeout: 90000 }).catch(() => {});
		}
	}
	await inp.fill(name);
	await p.click('button:has-text("Join circle")');
	return p;
};

const STAGGER = Number(process.env.PROBE_STAGGER ?? 900);
const NEGOTIATE = Number(process.env.PROBE_NEGOTIATE ?? 35000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const speakers = [];
const witnesses = [];
for (let i = 0; i < N; i++) {
	const p = await joinAs(`S${i}`);
	if (p) {
		p.on('pageerror', (e) => console.log(`  [s${i} err]`, e.message.slice(0, 140)));
		speakers.push(p);
	}
	await sleep(STAGGER);
}
for (let i = 0; i < W; i++) {
	const p = await joinAs(`W${i}`, true);
	if (p) {
		p.on('pageerror', (e) => console.log(`  [w${i} err]`, e.message.slice(0, 140)));
		witnesses.push(p);
	}
	await sleep(STAGGER);
}
const JOINED = speakers.length + witnesses.length;
console.log(`${JOINED}/${TOTAL} mounted + joined — unmuting speakers…`);
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
await speakers[0].waitForTimeout(NEGOTIATE);

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
		local: d?.media?.local?.length ?? 0,
		srdFails: await p.evaluate(() => window.__srdFails ?? -1)
	};
};

let allOk = true;
for (const [i, p] of speakers.entries()) {
	const r = await dump(p, `s${i}`);
	// speakers see all participants; remote feeds only from publishers
	const ok = r.peers >= JOINED - 1 && r.feeds >= N - 1;
	if (!ok) allOk = false;
	console.log(`  s${i}: peers=${r.peers} remoteFeeds=${r.feeds} liveTracks=${r.live} localTracks=${r.local} srdFails=${r.srdFails}${ok ? '' : '  ← MISS'}`);
}
for (const [i, p] of witnesses.entries()) {
	const r = await dump(p, `w${i}`);
	// witnesses see everyone, pull every speaker's feeds, publish nothing
	const ok = r.peers >= JOINED - 1 && r.feeds >= N && r.local === 0;
	if (!ok) allOk = false;
	console.log(`  w${i}: peers=${r.peers} remoteFeeds=${r.feeds} liveTracks=${r.live} localTracks=${r.local} srdFails=${r.srdFails}${ok ? '' : '  ← MISS'}`);
}

// zombie check: hard-close two speakers, survivors must drop them
console.log('killing s0+s1 — waiting for leave propagation…');
const victims = [speakers[0], speakers[1]];
await Promise.all(victims.map((p) => p.context().close()));
await speakers[2].waitForTimeout(90000);
const after = await dump(speakers[2], 's2');
console.log(`  s2 peers after kill: ${after.peers} (was ${JOINED - 1}, expect ≤ ${JOINED - 3})`);
const zombieOk = after.peers <= JOINED - 3;

console.log(allOk && zombieOk ? `PASS — ${JOINED} participants, zombies reaped` : `PARTIAL — peerMesh=${allOk} zombieReap=${zombieOk}`);
await browser.close();
process.exit(allOk && zombieOk ? 0 : 1);
