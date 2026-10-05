import { chromium, firefox } from '@playwright/test';

// Real-browser probe: headed Chromium + headed Firefox, REAL camera+mic
// (no fake-device flags) — cross-engine WebRTC + paid ISO recording on
// a genuine hardware feed, plus meter-rate observation.
const CODE = process.env.PROBE_CODE ?? '424242';
const BASE = process.env.PROBE_BASE ?? 'https://circle-engine-7ny.pages.dev';
const URL = `${BASE}/room/${CODE}`;
const REC_S = Number(process.env.PROBE_REC_S ?? 35);

const unmuteAll = (p) =>
	p.evaluate(() => {
		let hit = null;
		const mic = document.querySelector('[aria-label="Unmute mic"], [aria-label="Your microphone is muted"]');
		if (mic) { mic.click(); hit = 'mic'; }
		const cam = [...document.querySelectorAll('[aria-label]')].find((e) => /start camera|turn on camera/i.test(e.getAttribute('aria-label')));
		if (cam) { cam.click(); hit += '+cam'; }
		return hit;
	});
const debug = (p) => p.evaluate((c) => window.__cicDebug?.(c) ?? null, CODE);
const liveTracks = (d) =>
	Object.values(d?.media?.remote ?? {}).reduce((n, ts) => n + ts.filter((t) => t.endsWith(':live')).length, 0);
const entitlement = async () => {
	const r = await fetch(`${BASE}/api/ai/entitlement?room=${CODE}`);
	return r.json();
};

console.log('meter@start:', JSON.stringify(await entitlement()));

const crBrowser = await chromium.launch({ channel: 'chromium', headless: false });
const ffBrowser = await firefox.launch({ headless: false });

const joinAs = async (browser, name) => {
	const isFF = browser.browserType().name() === 'firefox';
	const ctx = await browser.newContext(
		isFF
			? {
					firefoxUserPrefs: {
						// auto-grant gUM — headed Fx would otherwise show a doorhanger
						// we can't click; keeps the REAL device (no fake stream)
						'media.navigator.permission.disabled': true
					}
				}
			: { permissions: ['microphone', 'camera'] }
	);
	const p = await ctx.newPage();
	p.on('pageerror', (e) => console.log(`  [${name} err]`, e.message.slice(0, 150)));
	p.on('console', (m) => {
		const t = m.text();
		if (t.startsWith('[gum]') || /publish|sfu|ontrack|addStream|\[engine\]/.test(t))
			console.log(`  [${name}]`, t.slice(0, 180));
	});
	// spy on media acquisition — log every request/result before app boots
	await p.addInitScript(() => {
		window.__gumStreams = [];
		const md = navigator.mediaDevices;
		const orig = md.getUserMedia.bind(md);
		md.getUserMedia = async (c) => {
			try {
				const s = await orig(c);
				window.__gumStreams.push(s);
				console.log(`[gum] ok ${JSON.stringify(c)} → ${s.getTracks().map((t) => t.kind).join('+')}`);
				return s;
			} catch (e) {
				console.log(`[gum] FAIL ${JSON.stringify(c)} → ${e.name}`);
				throw e;
			}
		};
	});
	await p.goto(URL);
	const inp = p.locator('input').first();
	await inp.waitFor({ state: 'visible', timeout: 60000 });
	await inp.fill(name);
	await p.click('button:has-text("Join circle")');
	return p;
};

const cr = await joinAs(crBrowser, 'RealChrome');
const ff = await joinAs(ffBrowser, 'RealFirefox');
await cr.waitForTimeout(8000);
console.log('cr unmute:', await unmuteAll(cr));
console.log('ff unmute:', await unmuteAll(ff));
// real devices + real ICE: publish/pull takes longer than headless — poll
for (let i = 0; i < 30; i++) {
	const a = await debug(cr), b = await debug(ff);
	if (liveTracks(a) > 0 && liveTracks(b) > 0) break;
	await cr.waitForTimeout(4000);
}

let d1 = await debug(cr), d2 = await debug(ff);
console.log('cr:', JSON.stringify({ peers: d1?.peers?.length, local: d1?.media?.local, live: liveTracks(d1) }));
console.log('ff:', JSON.stringify({ peers: d2?.peers?.length, local: d2?.media?.local, live: liveTracks(d2) }));
const streamDump = (p) =>
	p.evaluate(() =>
		window.__gumStreams.map((s, i) => `#${i} ` + s.getTracks().map((t) => `${t.kind}:${t.readyState}`).join('+')));
console.log('cr streams:', await streamDump(cr));
console.log('ff streams:', await streamDump(ff));
console.log('cr sfu:', JSON.stringify(await cr.evaluate((c) => window.__sfuDebug?.(c) ?? null, CODE)).slice(0, 300));
console.log('ff sfu:', JSON.stringify(await ff.evaluate((c) => window.__sfuDebug?.(c) ?? null, CODE)).slice(0, 300));
// mesh streams are empty on the cloud lane — the real check is prod's own
// remote <video> tiles actually playing decoded frames
const remoteVideo = (p) =>
	p.evaluate(() =>
		[...document.querySelectorAll('video')].map((v) => ({
			w: v.videoWidth,
			t: +v.currentTime.toFixed(1),
			tracks: (v.srcObject?.getTracks() ?? []).map((t) => `${t.kind}:${t.readyState}${t.muted ? ':m' : ''}`).join('+')
		})));
console.log('cr videos:', JSON.stringify(await remoteVideo(cr)));
console.log('ff videos:', JSON.stringify(await remoteVideo(ff)));

// paid ISO recording on a real feed — UI path like the headless probe
const uploads = [];
cr.on('request', (r) => { if (r.url().includes('/api/rec/')) uploads.push(`${r.method()} ${r.url().split('/').slice(-3).join('/')}`); });
cr.on('response', (r) => { if (r.url().includes('/api/rec/')) uploads.push(`  → ${r.status()}`); });

const clickText = (re) =>
	cr.evaluate((reSrc) => {
		const rx = new RegExp(reSrc, 'i');
		const el = [...document.querySelectorAll('button,[role="switch"],[role="tab"],a,[role="button"]')].find((b) =>
			rx.test(((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim().slice(0, 90)));
		if (el) { el.click(); return (el.textContent || '').trim().slice(0, 40); }
		return null;
	}, re.source);

await cr.evaluate(() => document.querySelector('[data-ux-id="chat"]')?.click());
await cr.waitForTimeout(1500);
console.log('rec tab:', await clickText(/^recording$/i));
await cr.waitForTimeout(900);
console.log('open sheet:', await clickText(/^start recording$/i));
await cr.waitForTimeout(1500);
console.log('local start:', await clickText(/start local recording/i));
await ff.waitForTimeout(4000);
console.log('ff consent:', await ff.evaluate(() => {
	const el = [...document.querySelectorAll('button')].find((b) => /stay and continue|consent/i.test(b.textContent || ''));
	if (el) { el.click(); return (el.textContent || '').trim().slice(0, 40); }
	return null;
}));
console.log(`recording ${REC_S}s on real hardware…`);
await cr.waitForTimeout(REC_S * 1000);
d1 = await debug(cr);
console.log('cr mid-rec:', JSON.stringify({ recording: d1?.recording, iso: d1?.isoRunning, consent: d1?.consent, local: d1?.media?.local }));

let stop = await clickText(/stop recording|stop local/i);
if (!stop) {
	await cr.evaluate(() => document.querySelector('[data-ux-id="chat"]')?.click());
	await cr.waitForTimeout(1200);
	await clickText(/^recording$/i);
	await cr.waitForTimeout(800);
	stop = await clickText(/stop recording|stop local/i);
}
console.log('stop:', stop);
for (let i = 0; i < 40 && !uploads.some((u) => u.includes('→ 201')); i++) await cr.waitForTimeout(2000);
console.log('uploads:', uploads);
console.log('meter@end:', JSON.stringify(await entitlement()));

await crBrowser.close();
await ffBrowser.close();
process.exit(uploads.some((u) => u.includes('→ 201')) ? 0 : 1);
