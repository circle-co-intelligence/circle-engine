/**
 * badges.ts — disclosure + action surfaces for the vendored prod frontend:
 *
 *   1. quality dots — connection quality 0–3 driven by the room's pressure
 *      level, so "why is it choppy" has a visible answer (always-on overlay)
 *   2. edge-processed pill — REQUIRED privacy disclosure whenever the paid
 *      edge-denoise lane is on (plaintext leaves E2EE at the SFU)
 *   3. circle actions (whiteboard/enhance/sense/top-up/invite/audit) — injected
 *      into the prod settings drawer's Appearance section (#settings-appearance)
 *      so the room stays composition-clean; the always-on overlay keeps only
 *      the two disclosures, same contract as prod's "not E2EE" badge.
 */
import type { RoomSession } from '../state/room.svelte';
import { lastIceReason } from '../net/room';

export function mountBadges(session: RoomSession): () => void {
	if (typeof document === 'undefined') return () => {};
	const root = document.createElement('div');
	root.id = 'cic-badges';
	root.style.cssText =
		'position:fixed;left:12px;bottom:12px;z-index:9999;display:flex;gap:8px;' +
		'align-items:center;pointer-events:none;font:600 11px/1 system-ui,sans-serif';

	const dots = document.createElement('div');
	dots.title = 'Connection quality';
	dots.style.cssText = 'display:flex;gap:3px;align-items:flex-end;opacity:.85';
	for (let i = 0; i < 4; i++) {
		const d = document.createElement('div');
		d.style.cssText = `width:4px;border-radius:2px;height:${5 + i * 4}px;background:#4a5568`;
		dots.appendChild(d);
	}
	root.appendChild(dots);

	const pill = document.createElement('div');
	pill.textContent = 'edge-processed — not E2EE';
	pill.style.cssText =
		'display:none;background:#7c3aed;color:#fff;padding:4px 10px;border-radius:999px;' +
		'letter-spacing:.02em;box-shadow:0 2px 8px #0006';
	root.appendChild(pill);

	// ear disclosure — REQUIRED whenever our mic ASR is feeding Milo's brain
	// seat (ear-set on): speech leaves the transcript scope you see
	const earpill = document.createElement('div');
	earpill.textContent = 'Milo is listening to your mic';
	earpill.title = 'Your speech is transcribed on-device and the text is sent to the room\'s AI seat. Turn off via Circle tools → let Milo hear me';
	earpill.style.cssText =
		'display:none;background:#0e7490;color:#fff;padding:4px 10px;border-radius:999px;' +
		'letter-spacing:.02em;box-shadow:0 2px 8px #0006';
	root.appendChild(earpill);

	// credits pill — paid AI/metered lanes hard-paused until a top-up lands;
	// the P2P call itself is unaffected
	const creditpill = document.createElement('div');
	creditpill.textContent = 'room credits exhausted — paid AI paused, top up in Circle tools';
	creditpill.style.cssText =
		'display:none;background:#b45309;color:#fff;padding:4px 10px;border-radius:999px;' +
		'letter-spacing:.02em;box-shadow:0 2px 8px #0006';
	root.appendChild(creditpill);

	// connectivity pill — the honest "what's wrong" surface for states prod
	// can't see: every lane failed (fatal), the ws bus cycling reconnects,
	// or peers stuck in failed/disconnected while ICE repair retries
	const netpill = document.createElement('div');
	netpill.style.cssText =
		'display:none;color:#fff;padding:4px 10px;border-radius:999px;' +
		'letter-spacing:.02em;box-shadow:0 2px 8px #0006';
	root.appendChild(netpill);

	// E2EE disclosure — REQUIRED when this browser can't do SFrame (no
	// insertable streams): media flows DTLS-only, and saying nothing would
	// silently overpromise the encryption posture
	const e2eepill = document.createElement('div');
	e2eepill.textContent = 'not end-to-end encrypted — browser lacks insertable streams';
	e2eepill.title = 'Media is transport-encrypted (DTLS) but not end-to-end SFrame encrypted';
	e2eepill.style.cssText =
		'display:none;background:#b91c1c;color:#fff;padding:4px 10px;border-radius:999px;' +
		'letter-spacing:.02em;box-shadow:0 2px 8px #0006';
	root.appendChild(e2eepill);

	document.body.appendChild(root);
	const COLORS = ['#4a5568', '#e53e3e', '#d69e2e', '#38a169'];
	const tick = window.setInterval(() => {
		const bars = dots.children;
		const level = 3 - Math.min(3, session.pressure); // invert: pressure↑ = bars↓
		for (let i = 0; i < bars.length; i++)
			(bars[i] as HTMLElement).style.background = i <= level ? COLORS[level] || '#38a169' : '#4a556866';
		pill.style.display = session.edgeProcessed ? 'block' : 'none';
		if (!session.e2ee.supported) {
			e2eepill.textContent = 'not end-to-end encrypted — browser lacks insertable streams';
			e2eepill.style.display = 'block';
		} else if (session.e2eeUncovered > 0) {
			e2eepill.textContent = `not end-to-end encrypted — ${session.e2eeUncovered} seat${session.e2eeUncovered > 1 ? 's' : ''} can't do SFrame`;
			e2eepill.style.display = 'block';
		} else {
			e2eepill.style.display = 'none';
		}
		earpill.style.display = session.ai.enabled && session.miloEars[session.selfId] ? 'block' : 'none';
		creditpill.style.display = session.creditsOut ? 'block' : 'none';
		if (session.signalState === 'down') {
			netpill.textContent = 'signaling unreachable — check connection, reload to retry';
			netpill.style.background = '#b91c1c';
			netpill.style.display = 'block';
		} else if (session.busDown) {
			netpill.textContent = 'reconnecting…';
			netpill.style.background = '#b45309';
			netpill.style.display = 'block';
		} else if (session.badPeers > 0) {
			netpill.textContent =
				lastIceReason === 'topup'
					? `connection trouble with ${session.badPeers} seat${session.badPeers > 1 ? 's' : ''} — relay credits exhausted, top up to restore TURN`
					: `connection trouble with ${session.badPeers} seat${session.badPeers > 1 ? 's' : ''} — retrying`;
			netpill.style.background = '#b45309';
			netpill.style.display = 'block';
		} else if (session.modelBusy.length) {
			const d = session.modelProgress[session.modelBusy[0]];
			netpill.textContent = d?.sizeHint
				? `downloading caption model — ${d.pct ?? 0}% of ~${d.sizeHint} (one-time, then cached)`
				: 'preparing on-device models… (first use downloads ~100MB)';
			netpill.style.background = '#b45309';
			netpill.style.display = 'block';
		} else if (session.modelFailed.length) {
			netpill.textContent = 'on-device AI models unavailable — captions/Milo degraded';
			netpill.style.background = '#b91c1c';
			netpill.style.display = 'block';
		} else {
			netpill.style.display = 'none';
		}
	}, 1000);

	// Excalidraw island — lazy-mounts into a floating panel, synced through
	// the same Y.Doc as notes (E2EE data channel, zero new transport)
	let panel: HTMLElement | null = null;
	let unmountWb: (() => void) | null = null;
	const toggleWb = async () => {
		const u = (await import('../obs/ux')).ux();
		if (panel) {
			unmountWb?.();
			panel.remove();
			panel = null;
			return;
		}
		u?.step('tool_opened');
		panel = document.createElement('div');
		panel.style.cssText =
			'position:fixed;inset:10% 12%;z-index:9998;background:#fff;border-radius:16px;' +
			'overflow:hidden;box-shadow:0 24px 80px #000c';
		document.body.appendChild(panel);
		try {
			const { mountWhiteboard } = await import('../whiteboard/island');
			unmountWb = await mountWhiteboard(panel, session.notes.doc);
			u?.step('tool_succeeded');
		} catch (e) {
			console.error('[whiteboard] mount failed', e);
			panel.textContent = `whiteboard unavailable — ${e instanceof Error ? e.message : e}`;
		}
	};

	// circle actions — paid opt-in lanes + host actions, injected into the
	// prod settings drawer's Appearance section so the room surface stays
	// uncluttered; each is an explicit click, each only shown when its
	// endpoint exists; edge/sensory break E2EE by design so the click is
	// the consent and the pill is the disclosure
	const env = import.meta.env as Record<string, string | undefined>;
	type Action = { label: string; desc: string; run: (b: HTMLButtonElement) => void };
	const actions: Action[] = [
		{ label: 'whiteboard', desc: 'Shared Excalidraw canvas for the circle', run: () => void toggleWb() },
		{
			label: 'let Milo hear me',
			desc: 'Opt-in: your speech (transcribed on-device) is shared with the room AI seat only',
			run: (b) => {
				const on = !session.miloEars[session.selfId];
				session.setEar(on);
				b.querySelector('strong')!.textContent = on ? 'Milo can hear you (on)' : 'let Milo hear me';
				setTimeout(() => (b.querySelector('strong')!.textContent = 'let Milo hear me'), 4000);
			}
		}
	];
	if (env.VITE_CIC_DSP_ENDPOINT) {
		actions.push(
			{ label: 'enhance audio', desc: 'Edge denoise — mic audio is processed unencrypted at the edge (paid)', run: () => void session.enableEdgeDenoise() },
			{ label: 'sense room', desc: 'Diarized captions + audio events via speech provider (paid)', run: () => void session.enableSensory() }
		);
	}
	if (env.VITE_CIC_AI_ENDPOINT) {
		actions.push({
			label: 'top up',
			desc: 'Credit this room\'s paid-seconds pool with a grant from your payment',
			run: async (b) => {
				const grant = prompt('Paste top-up grant');
				if (!grant) return;
				const { topUp } = await import('../tier');
				const ok = await topUp(session.roomCode, grant.trim());
				if (ok) session.markToppedUp();
				b.querySelector('strong')!.textContent = ok ? 'topped up' : 'invalid grant';
				setTimeout(() => (b.querySelector('strong')!.textContent = 'top up'), 4000);
			}
		});
	}
	actions.push(
		{
			label: 'invite',
			desc: 'Download a calendar invite for this circle',
			run: () => {
				void import('../notes/invite').then(({ icsInvite, downloadIcs }) => {
					downloadIcs(
						'circle.ics',
						icsInvite({
							title: 'Co-Intelligence Circle',
							startAt: new Date(Date.now() + 3600_000),
							minutes: 60,
							joinUrl: location.href
						})
					);
				});
			}
		},
		{
			label: 'audit',
			desc: 'Export the signed op-log (verifiable room record)',
			run: () => {
				void import('../audit/export').then(({ exportAudit }) => {
					const json = exportAudit(session.oplog.entries, session.oplog.epoch);
					const a = document.createElement('a');
					a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
					a.download = `circle-audit-${session.roomCode}.json`;
					a.click();
					URL.revokeObjectURL(a.href);
				});
			}
		}
	);

	// Render actions as prod-native preference rows inside the drawer's
	// Appearance section (#settings-appearance). The svelte-* scope class is
	// copied from a live prod element so scoped styles apply; re-injects via
	// MutationObserver because Svelte remounts the drawer on tab switches.
	const injectActions = (body: HTMLElement) => {
		if (document.getElementById('cic-extras')) return;
		const scope = body.querySelector('[class*="svelte-"]')?.className.match(/\bsvelte-[a-z0-9]+\b/)?.[0] ?? '';
		const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] => {
			const e = document.createElement(tag);
			e.className = `${cls}${scope ? ` ${scope}` : ''}`;
			if (text) e.textContent = text;
			return e;
		};
		const wrap = document.createElement('div');
		wrap.id = 'cic-extras';
		wrap.className = `grid gap-2 pt-2${scope ? ` ${scope}` : ''}`;
		wrap.appendChild(mk('h4', 'settings-flat-title', 'Circle tools'));
		for (const a of actions) {
			const b = mk('button', 'ui-preference-switch');
			b.type = 'button';
			const span = mk('span', 'grid');
			span.appendChild(mk('strong', '', a.label));
			span.appendChild(mk('span', 'text-[11px] text-[var(--muted)]', a.desc));
			b.appendChild(span);
			b.onclick = () => {
				void import('../obs/ux').then((m) => m.ux()?.step('tool_opened'));
				a.run(b);
			};
			wrap.appendChild(b);
		}
		body.appendChild(wrap);
	};
	const mo = new MutationObserver(() => {
		const body = document.getElementById('settings-appearance');
		if (body) injectActions(body);
	});
	mo.observe(document.body, { childList: true, subtree: true });
	const body = document.getElementById('settings-appearance');
	if (body) injectActions(body);

	return () => {
		window.clearInterval(tick);
		mo.disconnect();
		document.getElementById('cic-extras')?.remove();
		unmountWb?.();
		panel?.remove();
		root.remove();
	};
}
