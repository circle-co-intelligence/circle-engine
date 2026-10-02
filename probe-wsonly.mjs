import { chromium } from '@playwright/test';

const CODE = String(Math.floor(100000 + Math.random() * 900000));
const BASE = process.env.BASE ?? 'https://ws-only-test.circle-engine.pages.dev';
const URL = `${BASE}/room/${CODE}`;
console.log('room:', URL);

const browser = await chromium.launch({
	args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
});

const watch = (page, tag) => {
	page.on('console', (m) => {
		const t = m.text();
		if (/metric|speech-frame/.test(t)) return;
		console.log(`  [${tag}]`, t.slice(0, 220));
	});
	page.on('pageerror', (e) => console.log(`  [${tag} err]`, e.message.slice(0, 220)));
};

async function join(name, tag) {
	const page = await (await browser.newContext({ permissions: ['microphone', 'camera'] })).newPage();
	watch(page, tag);
	await page.goto(URL);
	const inp = page.locator('input').first();
	await inp.waitFor({ state: 'visible', timeout: 60000 });
	await inp.fill(name);
	await page.click('button:has-text("Join circle")');
	await page.waitForTimeout(4000);
	return page;
}

const a = await join('Ada', 'A');
const b = await join('Bo', 'B');
console.log('--- converge ---');
await a.waitForTimeout(15000);

for (const [p, tag] of [[a, 'A'], [b, 'B']]) {
	const dbg = await p.evaluate((code) => window.__cicDebug?.(code) ?? null, CODE).catch(() => null);
	console.log(`dbg ${tag}:`, JSON.stringify(dbg));
	const conn = await p.evaluate(() =>
		[...document.querySelectorAll('canvas,video')].length).catch(() => -1);
	console.log(`media-els ${tag}:`, conn);
}
await browser.close();
