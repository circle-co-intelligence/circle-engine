/**
 * island.ts — Excalidraw whiteboard synced through the room's existing Y.Doc
 * (same data channel as notes → already E2EE, already synced, zero new
 * transport). Elements live in doc.getMap('whiteboard') as JSON; remote
 * updates apply via updateScene. React+Excalidraw lazy-load only when the
 * island mounts — the bundle stays untouched for rooms that never draw.
 */
import type * as Y from 'yjs';
import { base } from '$app/paths';

// @excalidraw/excalidraw ships no ESM entry — main.js reads process.env at
// require time and dies in the browser. The production UMD dist is
// process-free; its webpack publicPath (fonts + vendor chunk) is
// EXCALIDRAW_ASSET_PATH || unpkg — we vendor the assets locally so nothing
// leaves the origin.
declare global {
	interface Window { EXCALIDRAW_ASSET_PATH?: string; React?: unknown; ReactDOM?: unknown; ExcalidrawLib?: Record<string, unknown> }
}

export async function mountWhiteboard(el: HTMLElement, doc: Y.Doc): Promise<() => void> {
	window.EXCALIDRAW_ASSET_PATH ??= `${location.origin}${base}/`;
	const [React, ReactDOM, { createRoot }] = await Promise.all([
		import('react'),
		import('react-dom'),
		import('react-dom/client')
	]);
	// the UMD sniffs its environment: dev serves it raw → it reads
	// window.React/ReactDOM; the prod build wraps it as CJS → module.exports.
	// It also digs into React internals (ReactCurrentOwner) which live on the
	// default export, not the ESM namespace — hand it the real object.
	const w = window as { React?: unknown; ReactDOM?: unknown };
	w.React ??= (React as { default?: unknown }).default ?? React;
	w.ReactDOM ??= (ReactDOM as { default?: unknown }).default ?? ReactDOM;
	// @ts-expect-error UMD bundle — no type declarations on the subpath
	const excalidraw = await import('@excalidraw/excalidraw/dist/excalidraw.production.min.js');
	const lib = excalidraw.Excalidraw ? excalidraw : window.ExcalidrawLib;
	const Excalidraw = lib?.Excalidraw as never;
	const { createElement } = React;
	const map = doc.getMap<unknown>('whiteboard');
	let applying = false;

	const api = await new Promise<{ updateScene: (s: { elements: unknown[] }) => void }>((res) => {
		const root = createRoot(el);
		root.render(
			createElement(Excalidraw as never, {
				excalidrawAPI: (a: never) => res(a),
				onChange: (elements: readonly { id: string }[]) => {
					if (applying) return;
					doc.transact(() => {
						for (const e of elements) map.set(e.id, e);
					});
				}
			})
		);
	});

	const onMap = () => {
		applying = true;
		api.updateScene({ elements: [...map.values()] as never[] });
		applying = false;
	};
	map.observe(onMap);
	onMap();
	return () => {
		map.unobserve(onMap);
		el.replaceChildren(); // react root unmounts with the node
	};
}
