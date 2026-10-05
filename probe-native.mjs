import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';

// Native↔browser live-room probe: browser joins the prod site, the Tauri
// binary is launched at the same room URL via CIC_WEB_URL, and the
// browser's __cicDebug reports whether the native peer arrived.
const CODE = String(Math.floor(100000 + Math.random() * 900000));
const BASE = process.env.PROBE_BASE ?? 'https://circle-engine-7ny.pages.dev';
const ROOM = `${BASE}/room/${CODE}?name=NativePeer`;
const dbg = (p) => p.evaluate((c) => window.__cicDebug?.(c) ?? null, CODE);

console.log('room:', ROOM);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('  [browser err]', e.message.slice(0, 150)));
await p.goto(`${BASE}/room/${CODE}`);
await p.locator('input').first().fill('BrowserPeer');
await p.click('button:has-text("Join circle")');
await p.waitForFunction((c) => window.__cicDebug?.(c)?.self, CODE, { timeout: 60000 });
console.log('browser seated, self =', (await dbg(p))?.self);

const app = spawn(process.env.CIC_NATIVE_LAUNCHER ?? '/home/terex/bin/circle-webrtc', [], {
	env: {
		...process.env,
		CIC_WEB_URL: ROOM,
		CIC_MOCK_CAPTURE: '1',
		CIC_AUTOJOIN: '1'
	},
	stdio: ['ignore', 'pipe', 'pipe'],
	detached: true
});
app.stderr.on('data', (d) => console.log('  [app stderr]', String(d).slice(0, 200)));
app.stdout.on('data', (d) => console.log('  [app]', String(d).slice(0, 200)));
console.log('app pid:', app.pid);

// CIC_AUTOJOIN clicks the room's Join button inside the shell; the browser
// side polls __cicDebug until the native peer appears in the mesh
let joined = false;
for (let i = 0; i < 45; i++) {
	await new Promise((r) => setTimeout(r, 2000));
	const d = await dbg(p);
	if (i % 10 === 0) console.log(`t+${i * 2}s peers=${d?.peers?.length ?? '?'} state=${JSON.stringify(d?.stick?.state)}`);
	if (d && d.peers.length >= 1) { joined = true; break; }
}
console.log(joined ? 'NATIVE PEER JOINED' : 'native peer never appeared');
const d = await dbg(p);
console.log('final debug:', JSON.stringify({ peers: d?.peers, opCount: d?.opCount, epoch: d?.epoch, stick: d?.stick }));
spawn('kill', [String(app.pid)]);
await browser.close();
process.exit(joined ? 0 : 1);
