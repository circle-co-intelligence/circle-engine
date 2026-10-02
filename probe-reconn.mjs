// Minimal reconnect repro: join two prod pages, watch room-socket churn for 100s.
import { chromium } from '@playwright/test';

const CODE = String(Math.floor(100000 + Math.random() * 900000));
const URL = `http://localhost:5173/room/${CODE}`;
console.log('room code:', CODE);

const browser = await chromium.launch({
	channel: 'chromium',
	args: [
		'--use-fake-ui-for-media-stream',
		'--use-fake-device-for-media-stream',
		`--use-file-for-fake-audio-capture=${process.env.HOME}/.cache/cic-probe/speech16_loop.wav`,
		'--autoplay-policy=no-user-gesture-required'
	]
});

const opens = { a: 0, b: 0 };
function watch(page, tag) {
	page.on('console', (m) => {
		const t = m.text();
		if (t.includes('open /ws/room')) { opens[tag]++; console.log(`  [${tag}] OPEN #${opens[tag]}`); }
		if (/metric|room-open-stack|sock-close-stack|sfu|track|engine|ws\.|watchdog|close_code|err/i.test(t)) console.log(`  [${tag}]`, t.slice(0, 400));
	});
	page.on('pageerror', (e) => console.log(`  [${tag} err]`, e.message.slice(0, 200)));
}

async function join(name, tag) {
	const page = await (await browser.newContext({ permissions: ['microphone', 'camera'] })).newPage();
	watch(page, tag);
	await page.goto(URL, { waitUntil: 'domcontentloaded' });
	// prod join form: name field + submit
	const nameInput = page.locator('input[name="name"], input[placeholder*="name" i], input[type="text"]').first();
	await nameInput.waitFor({ timeout: 15000 });
	await nameInput.fill(name);
	await Promise.all([
		page.waitForResponse?.(() => true).catch(() => {}),
		page.locator('button[type="submit"], button:has-text("Join"), button:has-text("Enter")').first().click()
	]).catch(() => page.locator('form').evaluate(f => f.requestSubmit()));
	return page;
}

const a = await join('Ada', 'a');
const b = await join('Ben', 'b');
console.log('joined; observing 100s');
await a.waitForTimeout(100_000);
console.log('opens:', JSON.stringify(opens));
await browser.close();
