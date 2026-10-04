/**
 * capability.ts — honest prejoin gate. If the browser fundamentally can't
 * do a video circle, say so up front instead of failing mysteriously after
 * join. Hard-blockers get a blocking notice; soft gaps (mediaDevices for a
 * witness, SFrame) are left to their own honest degrade paths.
 */
export function capabilityGate() {
	if (typeof document === 'undefined') return;
	const hard: string[] = [];
	if (typeof RTCPeerConnection !== 'function') hard.push('WebRTC (RTCPeerConnection)');
	if (hard.length) showBlock(hard);
}

function showBlock(missing: string[]) {
	const mount = () => {
		if (!document.body || document.getElementById('cic-caps')) return;
		const el = document.createElement('div');
		el.id = 'cic-caps';
		el.style.cssText =
			'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;' +
			'background:#0b0d12e6;font:500 14px/1.6 system-ui,sans-serif;color:#e2e8f0';
		el.innerHTML =
			`<div style="max-width:420px;padding:32px;text-align:center">` +
			`<div style="font-size:18px;font-weight:700;margin-bottom:12px">This browser can&rsquo;t run Circle</div>` +
			`<div style="margin-bottom:16px;color:#94a3b8">Missing: ${missing.join(', ')}.</div>` +
			`<div style="color:#94a3b8">Use a current Chrome, Firefox, or Safari &mdash; or join from the native app.</div>` +
			`<button id="cic-caps-x" style="margin-top:20px;padding:8px 18px;border-radius:8px;` +
			`border:1px solid #475569;background:transparent;color:#e2e8f0;cursor:pointer">continue anyway</button>` +
			`</div>`;
		document.body.appendChild(el);
		document.getElementById('cic-caps-x')!.onclick = () => el.remove();
	};
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
	else mount();
}
