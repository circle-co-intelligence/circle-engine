import { chromium } from '@playwright/test';

// Focused mini-probe: op-sync (late joiner learns lobby) → waiting → admit;
// then set-password → dave denied → prompt.
// Logs full frame traffic minus media noise.

const CODE = String(Math.floor(100000 + Math.random() * 900000));
const URL = `http://localhost:5173/room/${CODE}`;
console.log('room code:', CODE);

const browser = await chromium.launch({
	channel: 'chromium',
	args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
		`--use-file-for-fake-audio-capture=${process.env.HOME}/.cache/cic-probe/speech16_loop.wav`]
});

const watch = (page, tag) => {
	page.on('console', (m) => {
		const t = m.text();
		if (/speech-frame|speech-event|sfu|caption-update|metric|renegotiate/.test(t)) return;
		console.log(`  [${tag}]`, t.slice(0, 200));
	});
	page.on('pageerror', (e) => console.log(`  [${tag} err]`, e.message.slice(0, 200)));
};

async function join(name, tag) {
	const page = await (await browser.newContext({ permissions: ['microphone', 'camera'] })).newPage();
	watch(page, tag);
	await page.goto(URL);
	const inp = page.locator('input').first();
	await inp.waitFor({ state: 'visible', timeout: 45000 });
	await inp.fill(name);
	await page.click('button:has-text("Join circle")');
	await page.waitForTimeout(4000);
	return page;
}

const host = await join('Host', 'h');
const peer = await join('Peer', 'p');
console.log('--- joined; converge ---');
await host.waitForTimeout(12000);

const dbg = async (p, tag) => console.log(`  dbg ${tag}:`,
	JSON.stringify(await p.evaluate((code) => window.__cicDebug?.(code) ?? null, CODE)));

// 1) set-lobby on both (non-authority's is policy-rejected — also verifies policy)
for (const p of [host, peer])
	await p.evaluate((code) => window.__cicSend(code, { t: 'set-lobby', enabled: true }), CODE);
await host.waitForTimeout(2500);

console.log('--- carol joins while lobby on (should wait, not seat) ---');
const carol = await join('Carol', 'c');
await host.waitForTimeout(9000);
const carolWaiting = (await carol.locator(':text("waiting room")').count()) > 0;
console.log('carol waiting UI:', carolWaiting);
console.log('carol DOM:', await carol.evaluate(() =>
	[...document.querySelectorAll('h1,h2,h3,p,[role="status"],button')]
		.map((e) => (e.textContent || '').trim()).filter((t) => t && t.length < 60).slice(0, 15)));

// 2) admit carol — prod gates Lobby & access behind canManageRoom
//    (you === hostId), so only the AUTHORITY page sees Admit. Drive the real
//    UI there: dock "Room controls" → drawer → Options tab → Lobby & access.
console.log('--- admit carol ---');
let mgrPage = host;
for (const p of [host, peer, carol]) {
	const v = await p.evaluate((code) => window.__cicDebug?.(code), CODE);
	if (v && v.self === v.auth) { mgrPage = p; break; }
}
console.log('authority page chosen for admit');
await mgrPage.evaluate(() => document.querySelector('[data-ux-id="settings"]')?.click());
await mgrPage.waitForTimeout(1500);
// drawer nav: People | Appearance | Options — Lobby & access is under Options
await mgrPage.evaluate(() => {
	const t = [...document.querySelectorAll('nav.room-control-tabs button, [aria-label="Room controls"] button')]
		.find((e) => /^options/i.test((e.textContent || '').trim()));
	t?.click();
});
await mgrPage.waitForTimeout(1200);
console.log('manager buttons:', await mgrPage.evaluate(() =>
	[...document.querySelectorAll('button,[role="button"],[aria-label]')]
		.map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim())
		.filter((t) => t && t.length < 60)));
// expand "Lobby & access" if it's a nav row
await mgrPage.evaluate(() => {
	const row = [...document.querySelectorAll('button,[role="button"],*')]
		.filter((e) => e.children.length < 8)
		.find((e) => /lobby & access|lobby and access/i.test(e.textContent || ''));
	row?.click?.();
});
await mgrPage.waitForTimeout(1200);
// the waiting row renders "{name} is waiting" + an Admit button — prod's
// send() silently drops frames while its socket is mid-reconnect, so retry
// the click until carol's session actually flips admitted
let admitClicked = null;
for (let i = 0; i < 5; i++) {
	const c = await carol.evaluate((code) => window.__cicDebug?.(code)?.admitted ?? false, CODE);
	if (c) break;
	admitClicked = await mgrPage.evaluate(() => {
		const row = [...document.querySelectorAll('*')]
			.filter((e) => e.children.length < 8)
			.find((e) => /is waiting/i.test(e.textContent || ''));
		const btn = [...(row?.querySelectorAll('button') ?? [])]
			.find((b) => /admit/i.test((b.getAttribute('aria-label') || b.textContent || '').trim())) ??
			[...document.querySelectorAll('button')].find((b) => /^admit$/i.test((b.textContent || '').trim()) || /^admit/i.test(b.getAttribute('aria-label') || ''));
		if (btn) { btn.click(); return (btn.getAttribute('aria-label') || btn.textContent || '').trim(); }
		return null;
	});
	await mgrPage.waitForTimeout(2500);
}
console.log('admit clicked:', admitClicked);
await host.waitForTimeout(3000);
console.log('carol admitted (waiting gone):', (await carol.locator(':text("waiting room")').count()) === 0);
console.log('carol seats visible:', await carol.locator('[data-pid]').count());
for (const [t, p] of [['h', host], ['p', peer], ['c', carol]])
	console.log(`view ${t}:`, await p.evaluate((c) => window.__cicDebug?.(c), CODE));

// 2b) lobby off again — send on all seated pages so the authority's applies
for (const p of [host, peer, carol])
	await p.evaluate((code) => window.__cicSend(code, { t: 'set-lobby', enabled: false }), CODE);
await host.waitForTimeout(1500);

// 3) password — send on ALL seated pages; authority is lex-min peerId which
// may be carol. Non-authority sends are policy-rejected, authority's applies.
console.log('--- set-password + dave joins ---');
for (const p of [host, peer, carol])
	await p.evaluate((code) => window.__cicSend(code, { t: 'set-password', password: 'pw-42' }), CODE);
await host.waitForTimeout(2000);
await dbg(host, 'h'); await dbg(peer, 'p');
const dave = await join('Dave', 'd');
await host.waitForTimeout(10000);
await dbg(host, 'h'); await dbg(dave, 'd');
const daveDenied = (await dave.locator(':text("password-protected")').count()) > 0 ||
	(await dave.locator('[aria-label="Room password"]').count()) > 0;
console.log('dave denied+prompt:', daveDenied);
// host must NOT be locked out — check her page still shows room, no pw prompt
await host.waitForTimeout(6000);
console.log('host still in room:', (await host.locator('[aria-label="Room password"]').count()) === 0);
for (const [t, p] of [['h', host], ['d', dave]])
	console.log(`view ${t}:`, await p.evaluate((c) => window.__cicDebug?.(c), CODE));
console.log('dave DOM:', await dave.evaluate(() =>
	[...document.querySelectorAll('h1,h2,h3,p,[role="status"],button,input')]
		.map((e) => ((e.textContent || '') || e.getAttribute('aria-label') || '').trim()).filter((t) => t && t.length < 60).slice(0, 15)));

// 4) retry WITH the password — must join cleanly through prod's prompt field
console.log('--- dave retries with password ---');
const pwField = dave.locator('[aria-label="Room password"], input[type="password"]').first();
if (await pwField.count()) {
	await pwField.fill('pw-42');
	await dave.click('button:has-text("Join circle")');
	await dave.waitForTimeout(12000);
}
const daveJoined = (await dave.locator('[data-pid]').count()) > 0;
console.log('dave joined after password:', daveJoined, '| seats:', await dave.locator('[data-pid]').count(),
	'| prompt gone:', (await dave.locator('[aria-label="Room password"]').count()) === 0);
console.log('dave DOM:', await dave.evaluate(() =>
	[...document.querySelectorAll('h1,h2,h3,p,[role="status"],button,input')]
		.map((e) => ((e.textContent || '') || e.getAttribute('aria-label') || '').trim()).filter((t) => t && t.length < 60).slice(0, 15)));
console.log('view d:', await dave.evaluate((c) => window.__cicDebug?.(c), CODE));
await browser.close();
