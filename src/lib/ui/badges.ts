/**
 * badges.ts — the two required disclosure surfaces, rendered as a minimal
 * DOM overlay (the vendored prod frontend can't carry these states):
 *
 *   1. quality dots — connection quality 0–3 driven by the room's pressure
 *      level, so "why is it choppy" has a visible answer
 *   2. edge-processed pill — REQUIRED privacy disclosure whenever the paid
 *      edge-denoise lane is on (plaintext leaves E2EE at the SFU)
 *
 * Both mount once, unobtrusively, bottom-left — same contract as prod's own
 * "not E2EE" badge: visible, never silent.
 */
import type { RoomSession } from '../state/room.svelte';

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

	// whiteboard toggle — pointer events only on this chip
	const wb = document.createElement('button');
	wb.textContent = '✎ whiteboard';
	wb.style.cssText =
		'pointer-events:auto;background:#1a2233cc;color:#cbd2d9;border:1px solid #ffffff24;' +
		'padding:4px 10px;border-radius:999px;font:inherit;cursor:pointer;backdrop-filter:blur(6px)';
	root.appendChild(wb);

	document.body.appendChild(root);
	const COLORS = ['#4a5568', '#e53e3e', '#d69e2e', '#38a169'];
	const tick = window.setInterval(() => {
		const bars = dots.children;
		const level = 3 - Math.min(3, session.pressure); // invert: pressure↑ = bars↓
		for (let i = 0; i < bars.length; i++)
			(bars[i] as HTMLElement).style.background = i <= level ? COLORS[level] || '#38a169' : '#4a556866';
		pill.style.display = session.edgeProcessed ? 'block' : 'none';
	}, 1000);

	// Excalidraw island — lazy-mounts into a floating panel, synced through
	// the same Y.Doc as notes (E2EE data channel, zero new transport)
	let panel: HTMLElement | null = null;
	let unmountWb: (() => void) | null = null;
	wb.onclick = async () => {
		if (panel) {
			unmountWb?.();
			panel.remove();
			panel = null;
			return;
		}
		panel = document.createElement('div');
		panel.style.cssText =
			'position:fixed;inset:10% 12%;z-index:9998;background:#fff;border-radius:16px;' +
			'overflow:hidden;box-shadow:0 24px 80px #000c';
		document.body.appendChild(panel);
		try {
			const { mountWhiteboard } = await import('../whiteboard/island');
			unmountWb = await mountWhiteboard(panel, session.notes.doc);
		} catch {
			panel.textContent = 'whiteboard unavailable';
		}
	};

	return () => {
		window.clearInterval(tick);
		unmountWb?.();
		panel?.remove();
		root.remove();
	};
}
