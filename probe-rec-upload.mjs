import { chromium } from '@playwright/test';

// Focused paid-tier check: join an entitled room, record ~15s, stop, watch
// for PUT /api/rec/{room}/{recId}/{seg} — the sealed R2 upload.

const CODE = process.env.PROBE_CODE ?? '424242';
const BASE = process.env.PROBE_BASE ?? 'https://circle-engine-7ny.pages.dev';
const URL = `${BASE}/room/${CODE}`;

const browser = await chromium.launch({
	channel: 'chromium',
	args: [
		'--use-fake-ui-for-media-stream',
		'--use-fake-device-for-media-stream',
		`--use-file-for-fake-audio-capture=${process.env.HOME}/.cache/cic-probe/speech16_loop.wav`,
		'--autoplay-policy=no-user-gesture-required'
	]
});

// solo rooms never publish → prod never acquires media → nothing to ISO.
// a second participant forces real capture + SFU publish on both sides.
const joinAs = async (name) => {
	const p = await (await browser.newContext({ permissions: ['microphone', 'camera'] })).newPage();
	await p.goto(URL);
	const inp = p.locator('input').first();
	await inp.waitFor({ state: 'visible', timeout: 45000 });
	await inp.fill(name);
	await p.click('button:has-text("Join circle")');
	return p;
};

const unmuteAll = (p) =>
	p.evaluate(() => {
		let hit = null;
		const mic = document.querySelector('[aria-label="Unmute mic"], [aria-label="Your microphone is muted"]');
		if (mic) { mic.click(); hit = 'mic'; }
		const cam = [...document.querySelectorAll('[aria-label]')].find((e) => /start camera|turn on camera|unmute.*cam/i.test(e.getAttribute('aria-label')));
		if (cam) { cam.click(); hit += '+cam'; }
		return hit;
	});

const guest = await joinAs('Guest2');
const page = await joinAs('RecProbe');
const uploads = [];
page.on('request', (r) => {
	if (r.url().includes('/api/rec/')) uploads.push(`${r.method()} ${r.url()}`);
});
page.on('response', async (r) => {
	if (r.url().includes('/api/rec/')) uploads.push(`  → ${r.status()}`);
	if (r.url().includes('entitlement')) console.log('entitlement:', await r.text().catch(() => '?'));
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
page.on('console', (m) => {
	const t = m.text();
	if (/recording-state|rec-manifest|iso|consent|entitle|paid/i.test(t)) console.log('[pg]', t.slice(0, 200));
});

await page.waitForTimeout(6000);
// join lands muted with no captured feed — unmute so prod acquires media
// (the ISO recorder borrows that stream; nothing to record while muted)
console.log('guest unmute:', await unmuteAll(guest));
console.log('host unmute:', await unmuteAll(page));
await page.waitForTimeout(6000);
console.log('buttons:', await page.evaluate(() =>
	[...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).filter((a) => /mic|cam|video|audio|mute/i.test(a)).slice(0, 12)));
console.log('debug@join:', JSON.stringify(await page.evaluate((c) => window.__cicDebug?.(c) ?? null, CODE)));
// is our getUserMedia patch live? and does a direct call register a feed?
console.log('gum fn:', await page.evaluate(() => navigator.mediaDevices.getUserMedia.toString().slice(0, 140)));
await page.evaluate(async () => { try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { return String(e); } });
console.log('debug@gum:', JSON.stringify((await page.evaluate((c) => window.__cicDebug?.(c) ?? null, CODE))?.media ?? null));

const clickText = (re, sel = 'button,[role="switch"],[role="tab"],a,[role="button"]') =>
	page.evaluate(([reSrc, s]) => {
		const rx = new RegExp(reSrc, 'i');
		const el = [...document.querySelectorAll(s)].find((b) =>
			rx.test(((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).replace(/\s+/g, ' ').trim().slice(0, 90)));
		if (el) { el.click(); return (el.textContent || '').trim().slice(0, 40); }
		return null;
	}, [re.source, sel]);

// open the tools dock, then Recording tab → Start recording → Start local recording
await page.evaluate(() => document.querySelector('[data-ux-id="chat"]')?.click());
await page.waitForTimeout(1500);
console.log('recording tab:', await clickText(/^recording$/i));
await page.waitForTimeout(900);
console.log('open sheet:', await clickText(/^start recording$/i));
await page.waitForTimeout(1500);
console.log('local start:', await clickText(/start local recording/i));
// guest's recording notice → consent so recording proceeds with both seats
await guest.waitForTimeout(4000);
console.log('guest consent:', await guest.evaluate(() => {
	const el = [...document.querySelectorAll('button')].find((b) => /stay and continue|allow recording|consent/i.test(b.textContent || ''));
	if (el) { el.click(); return (el.textContent || '').trim().slice(0, 40); }
	return null;
}));
await page.waitForTimeout(3000);
console.log('debug:', JSON.stringify(await page.evaluate((c) => window.__cicDebug?.(c) ?? null, CODE)));
await page.waitForTimeout(37000); // record ~40s — crosses the 30s segment rotation
console.log('debug@40s:', JSON.stringify(await page.evaluate((c) => window.__cicDebug?.(c) ?? null, CODE)));

// sheet may have closed — reopen tools dock + Recording tab if needed
let stop = await clickText(/stop recording|stop local/i);
if (!stop) {
	await page.evaluate(() => document.querySelector('[data-ux-id="chat"]')?.click());
	await page.waitForTimeout(1200);
	await clickText(/^recording$/i);
	await page.waitForTimeout(800);
	stop = await clickText(/stop recording|stop local/i);
}
console.log('stop:', stop);
// wait generously — the segment must seal + PUT to R2
for (let i = 0; i < 40 && !uploads.some((u) => u.includes('→ 201')); i++) {
	await page.waitForTimeout(2000);
}
console.log('uploads seen:', uploads);
await browser.close();
process.exit(uploads.some((u) => u.includes('→ 201')) ? 0 : 1);
