import { chromium, firefox } from '@playwright/test';
const CODE = 'xsdp' + Date.now().toString(36);
const crB = await chromium.launch({ channel: 'chromium', headless: false });
const ffB = await firefox.launch({ headless: false });
const mkPage = async (b, name, opts) => {
	const p = await (await b.newContext(opts)).newPage();
	await p.addInitScript(() => {
		window.__pcs = [];
		const P = RTCRtpSender ? RTCPeerConnection : null;
		const orig = RTCPeerConnection.prototype.setRemoteDescription;
		RTCPeerConnection.prototype.setRemoteDescription = function (d) {
			return orig.call(this, d).catch((e) => {
				// forensic: which URI does this offer bind id 7 to, and which URI
				// did our local description bind it to?
				const idAt = (sdp, mid, id) => {
					const sec = (sdp ?? '').split('m=').slice(1).find(m => m.includes(`a=mid:${mid}`));
					const l = (sec ?? '').split('\r\n').find(x => x.startsWith(`a=extmap:${id} `) || x.startsWith(`a=extmap:${id}/`));
					return l ?? 'none';
				};
				const secs = (sdp) => (sdp ?? '').split('\r\nm=').slice(1).map(m => {
					const head = m.split('\r\n')[0].slice(0, 18);
					const ex = m.split('\r\n').filter(l => l.startsWith('a=extmap')).map(l => l.replace('a=extmap:', '').split(' ').map(p => p.split('/').pop()).join(':')).join(',');
					return `${head}=>${ex}`;
				});
				const midOf = (sdp) => { const m = sdp.split('\r\nm=').slice(1); return m.map(x => (x.match(/a=mid:(\d+)/) || [])[1]).join('.'); };
				console.log(`[srd-forensic] localType=${this.localDescription?.type}`);
				secs(d?.sdp).forEach((s, i) => console.log(`[srd-forensic] R.m${i}: ${s.slice(0, 200)}`));
				secs(this.localDescription?.sdp).forEach((s, i) => console.log(`[srd-forensic] L.m${i}: ${s.slice(0, 200)}`));
				const sdp = d?.sdp ?? '';
				const oline = sdp.split('\r\n').find(l => l.startsWith('o=')) ?? '';
				const mixed = sdp.includes('a=extmap-allow-mixed');
				const perM = sdp.split('m=').slice(1).map(m => {
					const head = m.split('\r\n')[0].slice(0, 20);
					const ex = m.split('\r\n').filter(l => l.startsWith('a=extmap')).map(l => l.replace('a=extmap:', '').split(' ')[0]).join(',');
					return `${head}|extids:${ex}`;
				}).join(' ;; ');
				console.log(`[srd-fail] ${e.message.slice(0,220)} || ${d?.type} o=${oline.slice(0,50)} mixed=${mixed} || ${perM}`);
				throw e;
			});
		};
		let n = 0;
		const proto = RTCPeerConnection.prototype;
		const num = (pc) => (pc.__n ??= n++);
		const origL = proto.setLocalDescription;
		proto.setLocalDescription = async function (d) {
			const tag = `sld#${num(this)}`;
			const ex = (s) => (s ?? '').split('\r\n').filter(l => l.startsWith('a=extmap:')).map(l => l.slice(8, 60)).join('|');
			try {
				await origL.call(this, d);
				console.log(`[${tag}] ok implicit=${d === undefined} st=${this.signalingState} localExt=${ex(this.localDescription?.sdp).slice(0, 160)}`);
			} catch (e) { console.log(`[${tag}] FAIL st=${this.signalingState} d=${d === undefined ? 'bare' : d?.type} ${e.message.slice(0, 140)}`); throw e; }
		};
	});
	p.on('console', m => { const t = m.text(); if (/srd-fail|srd-forensic|sld#/.test(t)) console.log(`  [${name}]`, t.slice(0, 300)); });
	p.on('pageerror', () => {});
	await p.goto(`https://circle-engine-7ny.pages.dev/room/${CODE}`);
	const inp = p.locator('input').first();
	await inp.waitFor({ state: 'visible', timeout: 90000 });
	await inp.fill(name);
	await p.click('button:has-text("Join circle")');
	return p;
};
const ff = await mkPage(ffB, 'ff', { firefoxUserPrefs: { 'media.navigator.permission.disabled': true, 'media.navigator.streams.fake': true } });
await ff.waitForTimeout(4000);
const cr = await mkPage(crB, 'cr', { permissions: ['microphone', 'camera'] });
for (const [p, n] of [[cr, 'cr'], [ff, 'ff']])
	await p.evaluate(() => {
		document.querySelector('[aria-label="Unmute mic"], [aria-label="Your microphone is muted"]')?.click();
		[...document.querySelectorAll('[aria-label]')].find(e => /start camera|turn on camera/i.test(e.getAttribute('aria-label')))?.click();
	});
await cr.waitForTimeout(60000);
for (const [p, n] of [[cr, 'cr'], [ff, 'ff']]) {
	const vids = await p.evaluate(() => [...document.querySelectorAll('video')].map(v => ({
		w: v.videoWidth, t: Math.round(v.currentTime), ready: v.readyState,
		tracks: v.srcObject?.getTracks?.().map(t => `${t.kind}:${t.readyState}`) ?? []
	})));
	console.log(`[${n}] videos:`, JSON.stringify(vids));
	const dbg = await p.evaluate(() => window.__cicDebug?.()).catch(() => null);
	console.log(`[${n}] debug:`, JSON.stringify(dbg?.media?.local ?? null), 'remoteStreams:', dbg?.media?.remote?.length ?? -1);
}
await crB.close(); await ffB.close(); process.exit(0);
// appended: unmute both, wait longer for the renegotiation that fails
