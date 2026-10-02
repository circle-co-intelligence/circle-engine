import { chromium } from '@playwright/test';
const CODE = String(Math.floor(100000 + Math.random() * 900000));
const URL = `http://localhost:5173/room/${CODE}`;
const browser = await chromium.launch({
	channel: 'chromium',
	args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
		`--use-file-for-fake-audio-capture=${process.env.HOME}/.cache/cic-probe/speech16_loop.wav`,
		'--autoplay-policy=no-user-gesture-required']
});
const hits = { a: new Set(), b: new Set() };
function watch(page, tag) {
	page.on('console', (m) => {
		const t = m.text();
		if (/tr-caption|caption-audio|fanout|translate|stt\]|wllama|Downloading|caption-source|speech-open|speech-close|source-ready|source-failed|tts/.test(t))
			console.log(`  [${tag}]`, t.slice(0, 200));
		for (const k of ['/ws/caption', 'tr-caption', 'caption-audio', 'translation-secret', 'caption-source-ready', '[stt] seg'])
			if (t.includes(k)) hits[tag].add(k);
	});
	page.on('pageerror', (e) => console.log(`  [${tag} err]`, e.message.slice(0, 200)));
}
async function join(name, tag) {
	const page = await (await browser.newContext({ permissions: ['microphone', 'camera'] })).newPage();
	watch(page, tag);
	await page.goto(URL);
	await page.locator('input').first().waitFor({ state: 'visible', timeout: 30000 });
	await page.locator('input').first().fill(name);
	await page.click('button:has-text("Join circle")');
	await page.waitForTimeout(4000);
	return page;
}
const clickText = (page, re, sel = 'button,[role="switch"],[role="tab"],a,[role="button"]') =>
	page.evaluate(([reSrc, s]) => {
		const rx = new RegExp(reSrc, 'i');
		const el = [...document.querySelectorAll(s)].find((b) =>
			rx.test(((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).replace(/\s+/g, ' ').trim().slice(0, 90)));
		if (el) { el.click(); return (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 70); }
		return null;
	}, [re.source, sel]);
const clickSel = (page, sel) =>
	page.evaluate((s) => { const el = document.querySelector(s); if (el) { el.click(); return true; } return false; }, sel);
async function clickRetry(page, re, tries = 8, sel) {
	for (let i = 0; i < tries; i++) {
		const r = await clickText(page, re, sel);
		if (r) return r;
		await page.waitForTimeout(600);
	}
	return null;
}

const a = await join('Ada', 'a');
const b = await join('Grace', 'b');
await a.waitForTimeout(8000); // let peers settle + media publish

// prod's real caption path: unmute so publishing opens, then the same wire op
// prod's transcript toggle sends (set-transcription) — the drawer UI is flaky
// in headless; the wire contract is what we're validating
for (const p of [a, b]) await clickSel(p, '[aria-label="Unmute mic"], [aria-label="Your microphone is muted"]');
await a.waitForTimeout(1500);
await a.evaluate((code) => window.__cicSend(code, { t: 'set-transcription', on: true }), CODE);
await a.waitForTimeout(2000);
// ASR warms: caption-source → source-ready → ticket → /ws/caption → segs
for (let i = 0; i < 45 && !(hits.a.has('[stt] seg') || hits.b.has('[stt] seg')); i++)
	await a.waitForTimeout(1000);
console.log('caption socket a:', hits.a.has('/ws/caption'), '| b:', hits.b.has('/ws/caption'));
console.log('segs a:', hits.a.has('[stt] seg'), '| b:', hits.b.has('[stt] seg'));

// declare translation langs on both — retry until the session view confirms
// (a frame sent while the socket is mid-rebind can land before session bind)
for (const p of [a, b]) {
	for (let i = 0; i < 10; i++) {
		await p.evaluate((code) => window.__cicSend(code, {
			t: 'participant-translation', lang: 'en', langs: ['es'], mintSecret: true
		}), CODE);
		await p.waitForTimeout(700);
		const v = await p.evaluate((c) => window.__cicDebug?.(c), CODE);
		if (v?.selfLangs?.includes('es')) break;
	}
}
await a.waitForTimeout(1000);
console.log('a view:', JSON.stringify(await a.evaluate((c) => window.__cicDebug?.(c), CODE)));
console.log('b view:', JSON.stringify(await b.evaluate((c) => window.__cicDebug?.(c), CODE)));

for (let i = 0; i < 75 && !(hits.a.has('tr-caption') || hits.b.has('tr-caption')); i++)
	await a.waitForTimeout(1000);
console.log('tr-caption a:', hits.a.has('tr-caption'), '| b:', hits.b.has('tr-caption'));
// caption-audio needs a final segment + the ~110MB sherpa TTS pack's first init
for (let i = 0; i < 120 && !(hits.a.has('caption-audio') || hits.b.has('caption-audio')); i++)
	await a.waitForTimeout(1000);
console.log('caption-audio a:', hits.a.has('caption-audio'), '| b:', hits.b.has('caption-audio'));
await browser.close();
