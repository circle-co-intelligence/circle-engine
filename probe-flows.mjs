import { chromium } from '@playwright/test';

// Two-party UI-driven verification against the real production frontend:
//  A) caption lane → /ws/caption socket (engine designates caption sources
//     once transcription is live + publishing — real backend policy)
//  B) recording consent (host starts; peer gets Recording notice → consents)
//  C) breakouts (open → peer self-hops → host assigns → peer returns → close)
//
// Host = lexicographic-min Trystero peerId — nondeterministic per run, so the
// probe detects which page holds host controls and drives host actions there.

const CODE = String(Math.floor(100000 + Math.random() * 900000));
const BASE = process.env.PROBE_BASE ?? 'http://localhost:5173';
const URL = `${BASE}/room/${CODE}`;
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

const hits = { a: new Set(), b: new Set(), c: new Set(), d: new Set() };
function watch(page, tag) {
	page.on('console', (m) => {
		const t = m.text();
		if (/speech-frame|speech-event|caption-update/.test(t)) return;
		for (const k of ['/ws/caption', 'caption-ticket', 'caption-source', 'recording-ready', 'recording-state',
			'breakout-open', 'breakout-assign', 'breakout-hop', 'breakout-move', 'breakout-close', 'breakout-broadcast',
			'recording-consent', 'tr-caption', 'caption-audio', 'participant-translation', 'translation-secret',
			'force-muted', 'admitted', 'lobby-wait', 'waiting-join', 'set-lobby', 'lobby-join',
			'removed', 'circle_closed', 'recordings', 'account-link', 'account-linked',
			'speaking', 'password_required', 'set-password', '[stt] seg'])
			if (t.includes(k)) hits[tag].add(k);
		if (/cic-ws|stt|caption|record|breakout|consent|engine\]|account|lobby|password|force-muted|removed|speaking|pageerror/i.test(t)) console.log(`  [${tag}]`, t.slice(0, 170));
	});
	page.on('pageerror', (e) => console.log(`  [${tag} err]`, e.message.slice(0, 180)));
}

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

const clickText = (page, re, sel = 'button,[role="switch"],[role="tab"],a,[role="button"]') =>
	page.evaluate(([reSrc, s]) => {
		const rx = new RegExp(reSrc, 'i');
		const el = [...document.querySelectorAll(s)].find((b) =>
			rx.test(((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).replace(/\s+/g, ' ').trim().slice(0, 90)));
		if (el) { el.click(); return (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 70); }
		return null;
	}, [re.source, sel]);

// seat-ring overlay intercepts pointer events over the dock in headless —
// use JS clicks throughout (real users hit the dock normally)
const clickSel = (page, sel) =>
	page.evaluate((s) => {
		const el = document.querySelector(s);
		if (el) { el.click(); return true; }
		return false;
	}, sel);

// click the first element matching `re`, retrying while it renders
async function clickRetry(page, re, tries = 8, sel) {
	for (let i = 0; i < tries; i++) {
		const r = await clickText(page, re, sel);
		if (r) return r;
		await page.waitForTimeout(600);
	}
	return null;
}

// poll a page.evaluate predicate until truthy or the budget expires — used
// instead of "wait N ms then try once" so a slow render doesn't read as a
// hard failure
async function pollFor(page, fn, arg, { tries = 10, interval = 500 } = {}) {
	for (let i = 0; i < tries; i++) {
		const r = await page.evaluate(fn, arg);
		if (r) return r;
		await page.waitForTimeout(interval);
	}
	return null;
}

// Ensure the settings drawer is open with a specific room-control tab
// (People|Appearance|Options) active. Re-checks actual DOM state on every
// call instead of trusting a single click to have landed — self-heals if a
// prior section left the drawer closed, mid-transition, or on the wrong tab
// (media/channel churn can remount the whole panel between probe steps).
async function ensureDrawerTab(page, tabRe, { tries = 14 } = {}) {
	// a stray dialog/toast from a prior section (mute confirm, recording
	// sheet, remove confirm) can sit on top of the dock and swallow clicks —
	// clear it first rather than let every retry below silently no-op
	await page.keyboard.press('Escape').catch(() => {});
	for (let i = 0; i < tries; i++) {
		const state = await page.evaluate((re) => {
			// prod ships TWO data-ux-id="settings" buttons (pre-join device check
			// and the in-room header one) — only the header button opens the
			// room-control drawer; discriminate by its accessible name
			if (!document.querySelector('button[data-ux-id="settings"][aria-label="Room controls"]')) return 'no-dock';
			// the settings BUTTON itself carries aria-label="Room controls" —
			// scope the nav lookup to the element type or the closed state is
			// misread as wrong-tab and the drawer never gets opened
			const nav = document.querySelector('nav.room-control-tabs, nav[aria-label="Room controls"]');
			if (!nav) return 'closed';
			const active = [...nav.querySelectorAll('button')].find((b) => b.getAttribute('aria-current') === 'page');
			return active && new RegExp(re, 'i').test(active.textContent || '') ? 'ready' : 'wrong-tab';
		}, tabRe.source);
		if (state === 'ready') return true;
		if (state === 'no-dock') { /* wait for remount below */ }
		else if (state === 'closed') await page.evaluate(() => document.querySelector('button[data-ux-id="settings"][aria-label="Room controls"]')?.click());
		else await page.evaluate((re) => {
			const t = [...document.querySelectorAll('nav.room-control-tabs button, nav[aria-label="Room controls"] button')]
				.find((e) => new RegExp(re, 'i').test((e.textContent || '').trim()));
			t?.click();
		}, tabRe.source);
		await page.waitForTimeout(600);
	}
	return false;
}

// Options tab → expand the "Lobby & access" accordion
// (aria-controls="settings-lobby") which renders the waiting list +
// Admit/Decline buttons. Self-heals the drawer/tab each call.
async function ensureLobbyAccessOpen(page) {
	if (!(await ensureDrawerTab(page, /^options/i))) return false;
	return !!(await pollFor(page, () => {
		const h = document.querySelector('button[aria-controls="settings-lobby"]');
		if (!h) return false;
		if (h.getAttribute('aria-expanded') !== 'true') h.click();
		return document.getElementById('settings-lobby') != null;
	}, null, { tries: 6, interval: 500 }));
}

// Reveal {name}'s seat-tile action row and open "Actions for {name}" so the
// Remove entry renders. Re-verifies the remove button's actual presence
// (not just that a click fired) before giving up on an attempt.
async function ensureActionsMenuOpen(page, name) {
	const hasTile = await pollFor(page, (n) =>
		[...document.querySelectorAll('[data-pid] [aria-label]')].some((b) => b.getAttribute('aria-label') === n),
		name, { tries: 12, interval: 800 });
	if (!hasTile) return false;
	for (let i = 0; i < 6; i++) {
		const hasRemove = await page.evaluate(() =>
			[...document.querySelectorAll('button[aria-label]')]
				.some((b) => /remove .* from the circle/i.test(b.getAttribute('aria-label') || '')));
		if (hasRemove) return true;
		await page.evaluate((n) => {
			const tile = [...document.querySelectorAll('[data-pid] [aria-label]')].find((b) => b.getAttribute('aria-label') === n);
			tile?.click();
		}, name);
		await page.waitForTimeout(500);
		await page.evaluate((n) => {
			const el = [...document.querySelectorAll('button[aria-label]')]
				.find((b) => (b.getAttribute('aria-label') || '') === `Actions for ${n}`);
			el?.click();
		}, name);
		await page.waitForTimeout(500);
	}
	return false;
}

const ada = await join('Ada', 'a');
const grace = await join('Grace', 'b');
console.log('--- joined; waiting for mesh convergence ---');
await ada.waitForTimeout(12000);

// detect host: only the host's page renders a "Mute {peer}" control on remote
// seat tiles — poll both pages since the tile mounts after media arrives
const remoteMuteCount = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('[data-pid] button[aria-label]')]
			.filter((b) => /^Mute .+/.test(b.getAttribute('aria-label')) && !/mic/i.test(b.getAttribute('aria-label')))
			.length);
// prefer the authoritative session view — the authority is always the room's
// manager; the mute-control heuristic below can lag a remount
let hostTag = null;
for (let i = 0; i < 25 && !hostTag; i++) {
	const av = await ada.evaluate((c) => window.__cicDebug?.(c), CODE).catch(() => null);
	const bv = await grace.evaluate((c) => window.__cicDebug?.(c), CODE).catch(() => null);
	if (av && av.self === av.auth) hostTag = 'a';
	else if (bv && bv.self === bv.auth) hostTag = 'b';
	else {
		const aN = await remoteMuteCount(ada);
		const bN = await remoteMuteCount(grace);
		hostTag = aN > 0 ? 'a' : bN > 0 ? 'b' : null;
	}
	if (!hostTag) await ada.waitForTimeout(1000);
}
if (!hostTag) {
	hostTag = 'a';
	console.log('  WARNING: host detection timed out — defaulting to a');
}
const host = hostTag === 'a' ? ada : grace;
const guest = hostTag === 'a' ? grace : ada;
const hostName = hostTag === 'a' ? 'Ada' : 'Grace';
const guestName = hostTag === 'a' ? 'Grace' : 'Ada';
console.log(`host = ${hostName} (tag ${hostTag})`);

// ---------- A) transcription → caption lane ----------
console.log('--- A: transcription → caption source → /ws/caption ---');
// unmute both so publishing gate opens (publishing && !muted.audio)
for (const p of [host, guest]) await clickSel(p, '[aria-label="Unmute mic"], [aria-label="Your microphone is muted"]');
await host.waitForTimeout(800);
// open tools panel via the chat dock button, then the Transcript tab
console.log('  chat dock:', await clickSel(host, '[data-ux-id="chat"]'));
await host.waitForTimeout(1200);
console.log('  transcript tab:', await clickRetry(host, /^transcript$/i));
if (!(await host.locator('aside[aria-label="Tools"]').count())) {
	const dbg = await host.evaluate(() =>
		[...document.querySelectorAll('aside,[role="dialog"],[class*="sheet"],[class*="panel"],nav')]
			.map((e) => `${e.tagName}[${e.getAttribute('aria-label') || e.className.toString().slice(0, 40)}] ${(e.textContent || '').trim().slice(0, 50)}`)
			.filter((t) => t.trim().length > 10).slice(0, 15));
	console.log('  panel dump:', JSON.stringify(dbg));
}
await host.waitForTimeout(800);
let en = await clickRetry(host, /turn on transcript|live transcript|enable.*transcript/i, 10);
if (!en) {
	const dump = await host.evaluate(() =>
		[...document.querySelectorAll('aside button, aside [role="switch"], [role="dialog"] button')]
			.map((b) => ((b.textContent || '') + '|' + (b.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim().slice(0, 60))
			.filter(Boolean));
	console.log('  panel buttons:', JSON.stringify(dump.slice(0, 25)));
	en = await clickRetry(host, /turn on transcript|live transcript/i, 5);
}
console.log('  enable:', en);
await host.waitForTimeout(4000);
// guest dismisses the Transcription notice (local ack — no wire frame)
await guest.waitForTimeout(800);
const tNotice = await guest.locator('[aria-label="Transcription notice"]').count();
console.log('  guest transcription notice:', tNotice > 0);
if (tNotice) console.log('  guest ack:', await clickText(guest, /stay and continue/i));
for (let i = 0; i < 30 && !(hits.a.has('/ws/caption') && hits.a.has('[stt] seg')); i++) await ada.waitForTimeout(1000);
console.log('  caption socket — ada:', hits.a.has('/ws/caption'), '| grace:', hits.b.has('/ws/caption'));
console.log('  sherpa decoded — ada:', hits.a.has('[stt] seg'), '| grace:', hits.b.has('[stt] seg'));
console.log('  caption-source:', hits.a.has('caption-source') || hits.b.has('caption-source'),
	'| ticket:', hits.a.has('caption-ticket') || hits.b.has('caption-ticket'));

// ---------- B) recording consent ----------
console.log('--- B: recording consent ---');
await host.waitForTimeout(1500);
// tools panel → Recording tab → Start recording (chat btn toggles — only open if closed)
let recTab = await clickRetry(host, /^recording$/i, 3);
if (!recTab) {
	await clickSel(host, '[data-ux-id="chat"]');
	await host.waitForTimeout(1200);
	recTab = await clickRetry(host, /^recording$/i);
}
console.log('  recording tab:', recTab);
await host.waitForTimeout(900);
// "Start recording" opens the sheet (ss); the real start is "Start local
// recording" inside it → prod sends recording{action:'start',local,requestId}
console.log('  open sheet:', await clickText(host, /^start recording$/i));
await host.waitForTimeout(1500);
console.log('  local start:', await clickText(host, /start local recording/i));
await host.waitForTimeout(2500);
await guest.waitForTimeout(1500);
const rNotice = await guest.locator('[aria-label="Recording notice"]').count();
console.log('  guest recording notice visible:', rNotice > 0);
await guest.screenshot({ path: '/tmp/shot-rec-guest.png' });
if (rNotice) console.log('  guest consent:', await clickText(guest, /stay and continue/i));
await host.waitForTimeout(4000);
console.log('  recording-ready received:', hits[hostTag].has('recording-ready'));
const hostRec = await host.locator('[aria-label="Recording active. View who is recording"]').count();
const guestRec = await guest.locator('[aria-label="Recording active. View who is recording"]').count();
console.log('  recording badge — host:', hostRec > 0, '| guest:', guestRec > 0);
await host.screenshot({ path: '/tmp/shot-rec.png' });

// ---------- C) breakouts ----------
console.log('--- C: breakouts ---');
console.log('  controls:', await clickSel(host, '[data-ux-id="settings"]'));
await host.waitForTimeout(1200);
console.log('  options tab:', await clickRetry(host, /^options$/i));
await host.waitForTimeout(800);
let bRow = await clickRetry(host, /breakout rooms/i);
if (!bRow) {
	const dump = await host.evaluate(() =>
		[...document.querySelectorAll('button,[role="switch"],[role="tab"],details summary')]
			.map((b) => ((b.textContent || '') + '|' + (b.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim().slice(0, 70))
			.filter(Boolean));
	console.log('  options buttons:', JSON.stringify(dump.slice(0, 30)));
	bRow = await clickRetry(host, /breakout/i, 5);
}
console.log('  breakout row:', bRow);
await host.waitForTimeout(900);
console.log('  mode choose:', await clickText(host, /^they choose$/i)); // freeJoin → guest self-hops
console.log('  open:', await clickText(host, /open breakouts/i));
await host.waitForTimeout(3500);
console.log('  breakout-open sent:', hits[hostTag].has('breakout-open'));
// guest: "Choose your room" pill bar → Room 1 (breakout-hop)
await guest.waitForTimeout(1500);
const roomBar = await guest.locator('[aria-label="Choose your room"]').count();
console.log('  guest room bar visible:', roomBar > 0);
if (roomBar) {
	console.log('  guest hops:', await clickText(guest, /room 1/i));
	await guest.waitForTimeout(2500);
}
console.log('  breakout-hop sent:', hits[hostTag === 'a' ? 'b' : 'a'].has('breakout-hop'));
console.log('  breakout-move received:', hits[hostTag === 'a' ? 'b' : 'a'].has('breakout-move'));
// host assigns guest to room 2 via roster buttons
const assignBtn = await host.evaluate((gname) => {
	const el = [...document.querySelectorAll(`[aria-label^="Move ${gname} to"]`)]
		.find((b) => !/main/i.test(b.getAttribute('aria-label')));
	if (el) { el.click(); return el.getAttribute('aria-label'); }
	return null;
}, guestName);
console.log('  assign clicked:', assignBtn);
await host.waitForTimeout(2500);
console.log('  breakout-assign sent:', hits[hostTag].has('breakout-assign'));
// guest returns to main circle
console.log('  guest return:', await clickText(guest, /return to main|main circle/i));
// channel moves make prod reconnect the room socket (media restart) — let the
// remount settle before driving the co-host controls again
await host.waitForTimeout(6000);
await guest.waitForTimeout(2000);
// host broadcast + close — prod reconnects/remounts on channel moves, so the
// tools panel may be unmounted; the whole navigation is retried until the
// close control lands. The co-host details carries both the "to all rooms"
// broadcast form and "Close breakouts and return everyone".
// the host's breakout section (Options → "Breakout rooms" row) holds the
// roster, a "Message all rooms…" broadcast form and "Bring everyone back"
const breakoutSectionOpen = () => host.locator('button:has-text("Bring everyone back")').count();
const openBreakoutPanel = async () => {
	// the settings panel aside carries no label — its scroll container does
	if ((await host.locator('.settings-scroll').count()) === 0)
		await clickSel(host, '[data-ux-id="settings"]');
	await host.waitForTimeout(1200);
	await clickRetry(host, /^options$/i, 4);
	await host.waitForTimeout(600);
	// the row click toggles — only expand when the section isn't mounted yet
	if ((await breakoutSectionOpen()) === 0) {
		await clickText(host, /breakout rooms/i);
		await host.waitForTimeout(600);
	}
};
const bcastForm = () => host.evaluate(() => {
	const inp = [...document.querySelectorAll('form input')]
		.find((i) => /rooms/i.test(i.placeholder || '') || /rooms/i.test(i.getAttribute('aria-label') || ''));
	if (!inp) return false;
	const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
	set.call(inp, 'Come back soon');
	inp.dispatchEvent(new Event('input', { bubbles: true }));
	inp.closest('form').requestSubmit();
	return true;
});
await openBreakoutPanel();
let bcast = await bcastForm();
if (!bcast) { await host.waitForTimeout(1500); await openBreakoutPanel(); bcast = await bcastForm(); }
console.log('  broadcast sent:', bcast);
await guest.waitForTimeout(1500);
console.log('  breakout-broadcast frame:', hits[hostTag].has('breakout-broadcast'));
// host label is "Bring everyone back"; the co-host variant reads
// "Close breakouts and return everyone"
let closeBtn = await clickText(host, /bring everyone back|close breakouts/i);
for (let attempt = 0; attempt < 10 && !hits[hostTag].has('breakout-close'); attempt++) {
	if (closeBtn) break;
	await openBreakoutPanel();
	closeBtn = await clickText(host, /bring everyone back|close breakouts/i);
	await host.waitForTimeout(1500);
}
console.log('  close:', closeBtn);
await host.waitForTimeout(2500);
console.log('  breakout-close sent:', hits[hostTag].has('breakout-close'));
await host.screenshot({ path: '/tmp/shot-breakouts.png' });
await guest.screenshot({ path: '/tmp/shot-breakouts-guest.png' });

const guestTag = hostTag === 'a' ? 'b' : 'a';

// ---------- D) translation fanout ----------
// Both sides declare a target lang through the real wire path — whoever holds
// the caption-source role fans out tr-caption + caption-audio to the other.
// (prod's per-tile globe menu is menu-heavy; __cicSend is the identical frame
// prod sends, routed through RoomSocket.send → real bridge dispatch)
console.log('--- D: translation fanout ---');
// the breakout/media churn above tears prod's speech pipe down — re-arm via
// set-transcription (the wire op prod's transcript toggle sends); an injected
// caption-subscribe gets reverted by prod's next sync()
for (const p of [host, guest])
	await p.evaluate((code) => window.__cicSend(code, { t: 'set-transcription', on: true }), CODE);
await host.waitForTimeout(6000); // caption-source → socket open → ASR warms
// langs can land while a socket is mid-rebind (session not yet bound) —
// retry until the session view confirms registration
for (const p of [host, guest]) {
	for (let i = 0; i < 10; i++) {
		await p.evaluate((code) => window.__cicSend(code, {
			t: 'participant-translation', lang: 'en', langs: ['es'], mintSecret: true
		}), CODE);
		await p.waitForTimeout(700);
		const v = await p.evaluate((c) => window.__cicDebug?.(c), CODE);
		if (v?.selfLangs?.includes('es')) break;
	}
}
// sherpa ASR segments → wllama translate (lazy model load is slow first time)
// → sherpa TTS → tr-segment realtime → consumer frames
for (let i = 0; i < 60 && !(hits[guestTag].has('tr-caption') || hits[hostTag].has('tr-caption')); i++)
	await ada.waitForTimeout(1000);
console.log('  translation-secret:', hits[hostTag].has('translation-secret') || hits[guestTag].has('translation-secret'));
// caption-audio trails the final's text by the TTS generate (warm ~10s first)
for (let i = 0; i < 45 && !(hits[guestTag].has('caption-audio') || hits[hostTag].has('caption-audio')); i++)
	await ada.waitForTimeout(1000);
// tr-caption can still land inside the audio window — report both after it
console.log('  tr-caption — host:', hits[hostTag].has('tr-caption'), '| guest:', hits[guestTag].has('tr-caption'));
console.log('  caption-audio — host:', hits[hostTag].has('caption-audio'), '| guest:', hits[guestTag].has('caption-audio'));
console.log('  speaking op — host:', hits[hostTag].has('speaking'), '| guest:', hits[guestTag].has('speaking'));

// Translation verified — stop the background ASR/TTS/wllama pipeline before
// driving the UI-heavy sections below. Unlike TTS (worker-based), our sherpa
// ASR decode runs on the main thread; continuous recognition + translation
// orchestration can back up the event loop long enough that prod's 45s
// no-traffic watchdog (ws reconnects if it hears nothing that long) trips
// repeatedly, tearing the whole room shell down mid-click. Quieting it here
// is the actual fix for that instability — not longer click-retry budgets.
for (const p of [host, guest])
	await p.evaluate((code) => window.__cicSend(code, { t: 'set-transcription', on: false }), CODE).catch(() => {});
await host.waitForTimeout(2000);

// ---------- E) remote force-mute ----------
console.log('--- E: remote force-mute ---');
const muteClicked = await host.evaluate((gname) => {
	const el = [...document.querySelectorAll('[data-pid] button[aria-label]')]
		.find((b) => /^Mute .+/.test(b.getAttribute('aria-label')) && b.getAttribute('aria-label').includes(gname));
	if (el) { el.click(); return el.getAttribute('aria-label'); }
	return null;
}, guestName);
console.log('  mute click:', muteClicked);
await guest.waitForTimeout(3500);
console.log('  force-muted on guest:', hits[guestTag].has('force-muted'));

// ---------- F) account-link ----------
// prod's poll timer lives inside its own UI flow (H2): drawer → "Log in" →
// window.open(about:blank) → account-link-start → challenge → popup navigates
// to loginUrl (/account/link?ch=…) → prod polls account-link-poll every 2s.
// An injected frame can't trigger it — drive the real button and popup.
console.log('--- F: account-link ---');
// prod renders "Log in" inside the settings drawer's People tab (Se==="people")
// and opens window.open("about:blank") on click — retry the WHOLE sequence
// (not just the final click) since any step (drawer/tab state, popup-open
// racing a transition, challenge delivery) can transiently miss once.
let loginClicked = null;
let linkPage = null;
for (let attempt = 0; attempt < 4 && !hits[guestTag].has('account-linked'); attempt++) {
	if (!(await ensureDrawerTab(guest, /^people/i))) continue;
	const loginBtn = guest.locator('button:has-text("Log in"), a:has-text("Log in"), .account-row :is(button,a)').first();
	if (!(await loginBtn.count())) { await guest.waitForTimeout(800); continue; }
	// a real Playwright click (trusted, has transient activation) — an
	// untrusted el.click() gets popup-blocked by Chromium
	const popupP = guest.context().waitForEvent('page', { timeout: 10000 }).catch(() => null);
	await loginBtn.click().catch(() => {});
	loginClicked = 'Log in';
	linkPage = await popupP;
	if (!linkPage) continue; // popup missed/blocked — retry the click fresh
	const navigated = await linkPage.waitForURL(/\/account\/link/, { timeout: 10000 }).then(() => true).catch(() => false);
	if (!navigated) { await linkPage.close().catch(() => {}); continue; }
	const linkBtn = linkPage.locator('button:has-text("Link account")');
	if (await linkBtn.count()) {
		await linkBtn.click();
		for (let i = 0; i < 10 && !hits[guestTag].has('account-linked'); i++) await guest.waitForTimeout(1000);
	}
	if (!hits[guestTag].has('account-linked')) await linkPage.close().catch(() => {});
}
if (!loginClicked)
	console.log('  people panel:', await guest.evaluate(() => ({
		row: !!document.querySelector('.account-row'),
		ariaTabs: [...document.querySelectorAll('[aria-current]')].map((b) => (b.getAttribute('aria-current') || '') + ':' + (b.textContent || '').trim()),
		buttons: [...document.querySelectorAll('aside button, [role="dialog"] button, .settings-scroll button, .account-row button')]
			.map((b) => ((b.textContent || '') + '|' + (b.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim().slice(0, 60))
			.filter(Boolean).slice(0, 25)
	})));
console.log('  log-in clicked:', loginClicked);
console.log('  challenge issued:', hits[guestTag].has('account-link'), '| account-linked received:', hits[guestTag].has('account-linked'));
await guest.keyboard.press('Escape').catch(() => {});

// ---------- G) lobby → waiting → admit → remove ----------
console.log('--- G: lobby + admit + remove ---');
await host.evaluate((code) => window.__cicSend(code, { t: 'set-lobby', enabled: true }), CODE);
// wait for the op to apply on the authority view before a joiner arrives —
// otherwise she replays ops into an unconverged authority
for (let i = 0; i < 10; i++) {
	await host.waitForTimeout(800);
	const v = await host.evaluate((c) => window.__cicDebug?.(c), CODE);
	if (v?.lobby === true) break;
}
console.log('  set-lobby sent:', hits[hostTag].has('set-lobby'));
const carol = await join('Carol', 'c');
// lobby-wait is a mesh-internal frame — assert on prod's waiting-room UI text
// ("You're in the waiting room") + the host's "Someone is waiting to join" notice
let carolWaiting = false;
for (let i = 0; i < 25 && !carolWaiting; i++) {
	await ada.waitForTimeout(1000);
	carolWaiting = (await carol.locator(':text("waiting room")').count()) > 0;
}
console.log('  carol held in waiting:', carolWaiting);
const cv = await carol.evaluate((c) => window.__cicDebug?.(c), CODE);
console.log('  carol view:', JSON.stringify({ lobby: cv?.lobby, waitingSelf: cv?.waitingSelf, auth: cv?.auth === cv?.self }));
await host.waitForTimeout(1500);
const hostNotice = (await host.locator(':text("waiting to join")').count()) > 0;
console.log('  host saw waiting notice:', hostNotice, '| waiting-join op:', hits[hostTag].has('waiting-join'));
// prod gates Lobby & access behind canManageRoom (you === hostId) — find the
// page whose session IS the authority rather than assuming it's `host`.
// Carol (the joiner) is deliberately excluded from candidacy: right after she
// joins, her OWN debugView can transiently read self===auth for a moment —
// before her hello round-trips and the host's lobby-wait lands, her local
// peer list may still be near-empty, making her briefly appear self-elected.
// She can never legitimately be the admitting manager, so including her risks
// latching onto that one-shot false read (the loop takes the first match and
// never re-validates it).
let mgrPage = null;
for (let i = 0; i < 10 && !mgrPage; i++) {
	for (const p of [host, guest]) {
		const v = await p.evaluate((c) => window.__cicDebug?.(c), CODE);
		if (v && v.self === v.auth) { mgrPage = p; break; }
	}
	if (!mgrPage) await host.waitForTimeout(500);
}
if (!mgrPage) mgrPage = host;
// the waiting row renders "{name} is waiting" + an Admit button — prod's
// send() silently drops frames while its socket is mid-reconnect, and the
// drawer/tab/accordion can get knocked back closed between attempts (media
// churn remounts), so each retry re-establishes the whole panel state
// rather than just re-clicking into a possibly-stale DOM.
let admitClicked = null;
for (let i = 0; i < 10; i++) {
	const c = await carol.evaluate((code) => window.__cicDebug?.(code)?.admitted ?? false, CODE);
	if (c || hits.c.has('admitted')) { admitClicked = '(already admitted)'; break; }
	if (!(await ensureLobbyAccessOpen(mgrPage))) { await mgrPage.waitForTimeout(800); continue; }
	admitClicked = await pollFor(mgrPage, () => {
		const row = [...document.querySelectorAll('*')]
			.filter((e) => e.children.length < 8)
			.find((e) => /is waiting/i.test(e.textContent || ''));
		const btn = [...(row?.querySelectorAll('button') ?? [])]
			.find((b) => /admit/i.test((b.getAttribute('aria-label') || b.textContent || '').trim())) ??
			[...document.querySelectorAll('button')].find((b) => /^admit$/i.test((b.textContent || '').trim()) || /^admit/i.test(b.getAttribute('aria-label') || ''));
		if (btn) { btn.click(); return (btn.getAttribute('aria-label') || btn.textContent || '').trim(); }
		return null;
	}, null, { tries: 5, interval: 500 });
	if (!admitClicked) {
		console.log('  options panel:', await mgrPage.evaluate(() =>
			[...document.querySelectorAll('button')]
				.map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50))
				.filter(Boolean).slice(0, 30)));
		await mgrPage.waitForTimeout(1500);
	}
}
console.log('  admit clicked:', admitClicked);
console.log('  carol admitted:', hits.c.has('admitted') || (await carol.evaluate((c) => window.__cicDebug?.(c)?.admitted, CODE)));
// close the settings drawer — its overlay can swallow the tile button click
await mgrPage.keyboard.press('Escape').catch(() => {});
await mgrPage.waitForTimeout(800);
// prod: the seat tile itself (aria-label="{name}", role=button, inside
// [data-pid]) reveals the action row on click → "Actions for {name}" →
// "Remove {name} from the circle" → confirm dialog aria-label="Remove
// participant" → "Remove" sends {t:"remove"}. ensureActionsMenuOpen
// verifies the Remove button is actually present (not just that a click
// fired) before each attempt, and re-opens the menu if it closed.
let rm = null;
for (let i = 0; i < 8 && !rm; i++) {
	if (!(await ensureActionsMenuOpen(mgrPage, 'Carol'))) { await mgrPage.waitForTimeout(500); continue; }
	rm = await mgrPage.evaluate(() => {
		const el = [...document.querySelectorAll('button[aria-label]')]
			.find((b) => /remove .* from the circle/i.test(b.getAttribute('aria-label') || ''));
		if (el) { el.click(); return el.getAttribute('aria-label'); }
		return null;
	});
}
if (!rm)
	console.log('  tile buttons:', await mgrPage.evaluate(() =>
		[...document.querySelectorAll('[data-pid] button[aria-label]')]
			.map((b) => b.getAttribute('aria-label')).filter(Boolean)));
console.log('  remove clicked:', rm);
const rmConfirm = !!(await pollFor(mgrPage, () => {
	const dlg = document.querySelector('[aria-label="Remove participant"]');
	const btn = dlg && [...dlg.querySelectorAll('button')].find((b) => /^remove$/i.test((b.textContent || '').trim()));
	if (btn) { btn.click(); return true; }
	return false;
}, null, { tries: 8, interval: 500 }));
console.log('  confirmed:', rmConfirm);
for (let i = 0; i < 8 && !hits.c.has('removed'); i++) await carol.waitForTimeout(1000);
console.log('  carol removed:', hits.c.has('removed'), '| circle_closed:', hits.c.has('circle_closed'));
await carol.screenshot({ path: '/tmp/shot-removed.png' }).catch(() => {});
// reset lobby for the password lane — non-authority sends are policy-rejected,
// the authority's applies (send on every seated page so one lands)
for (const p of [host, guest])
	await p.evaluate((code) => window.__cicSend(code, { t: 'set-lobby', enabled: false }), CODE).catch(() => {});
await host.waitForTimeout(1500);

// ---------- H) recording stop → recordings list ----------
console.log('--- H: stop recording → recordings ---');
// tools panel → Recording tab → stop — the sheet toggles, retry open if needed
if ((await host.locator('button:has-text("Stop")').count()) === 0) {
	await clickSel(host, '[data-ux-id="chat"]');
	await host.waitForTimeout(1200);
	await clickRetry(host, /^recording$/i, 4);
	await host.waitForTimeout(800);
}
console.log('  stop click:', await clickRetry(host, /stop recording|stop local/i, 6));
// prod-parity: a stopped local recording surfaces in prod's "Your local
// recordings" section (blob stays on-device, no server frame). The
// `recordings` wire frame is only for server/cloud artifacts — don't expect it.
await host.waitForTimeout(4000); // MediaRecorder finalize + onLocalReady
await clickSel(host, '[data-ux-id="chat"]');
await host.waitForTimeout(800);
await clickRetry(host, /^recording$/i, 4);
await host.waitForTimeout(1200);
const localRecs = await host.evaluate(() => ({
	section: !!document.querySelector('.local-downloads'),
	items: document.querySelectorAll('.local-downloads button, .local-downloads a').length,
	text: /your local recordings/i.test(document.body.innerText)
}));
console.log('  local recordings UI:', JSON.stringify(localRecs), '| recordings frame:', hits[hostTag].has('recordings'));

// ---------- I) room password ----------
console.log('--- I: room password ---');
// send on every seated page — the wire op is manager-gated, only the
// authority's send applies (others are policy-rejected, harmlessly)
for (const p of [host, guest])
	await p.evaluate((code) => window.__cicSend(code, { t: 'set-password', password: 'probe-pw-42' }), CODE).catch(() => {});
// wait until the authority view converged on the password hash before Dave joins
for (let i = 0; i < 10; i++) {
	await host.waitForTimeout(800);
	const v = await host.evaluate((c) => window.__cicDebug?.(c), CODE);
	const g = await guest.evaluate((c) => window.__cicDebug?.(c), CODE);
	if (v?.pw && g?.pw) break;
}
console.log('  set-password sent:', hits[hostTag].has('set-password'));
// Dave joins without a password → denied by member verification → prompt
const dave = await (await browser.newContext({ permissions: ['microphone', 'camera'] })).newPage();
watch(dave, 'd');
await dave.goto(URL);
const dInp = dave.locator('input').first();
await dInp.waitFor({ state: 'visible', timeout: 45000 });
await dInp.fill('Dave');
await dave.click('button:has-text("Join circle")');
for (let i = 0; i < 25 && !hits.d.has('password_required'); i++) await dave.waitForTimeout(1000);
console.log('  dave denied (password_required):', hits.d.has('password_required'));
// wrong password → second prompt with "Wrong password"
let pwBox = dave.locator('[aria-label="Room password"]');
for (let i = 0; i < 10 && !(await pwBox.count()); i++) await dave.waitForTimeout(800);
if (await pwBox.count()) {
	await pwBox.fill('nope');
	await clickText(dave, /join|continue|enter/i);
	for (let i = 0; i < 20; i++) { await dave.waitForTimeout(1000); if (await dave.locator(':text("Wrong password")').count()) break; }
	console.log('  wrong-password feedback:', (await dave.locator(':text("Wrong password")').count()) > 0);
	// correct password → admitted
	pwBox = dave.locator('[aria-label="Room password"]');
	if (await pwBox.count()) await pwBox.fill('probe-pw-42');
	await clickText(dave, /join|continue|enter/i);
}
let daveIn = false;
for (let i = 0; i < 30 && !daveIn; i++) {
	await dave.waitForTimeout(1000);
	daveIn = (await dave.locator('[data-pid]').count()) > 0;
}
console.log('  dave joined with password:', daveIn);
await dave.screenshot({ path: '/tmp/shot-password.png' }).catch(() => {});

console.log('\n=== RESULT ===');
console.log('ada hits   :', [...hits.a].join(', '));
console.log('grace hits :', [...hits.b].join(', '));
console.log('carol hits :', [...hits.c].join(', '));
console.log('dave hits  :', [...hits.d].join(', '));
await browser.close();
