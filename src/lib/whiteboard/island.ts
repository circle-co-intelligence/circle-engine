/**
 * island.ts — Excalidraw whiteboard synced through the room's existing Y.Doc
 * (same data channel as notes → already E2EE, already synced, zero new
 * transport). Elements live in doc.getMap('whiteboard') as JSON; remote
 * updates apply via updateScene. React+Excalidraw lazy-load only when the
 * island mounts — the bundle stays untouched for rooms that never draw.
 */
import type * as Y from 'yjs';

export async function mountWhiteboard(el: HTMLElement, doc: Y.Doc): Promise<() => void> {
	const [{ createElement }, { createRoot }, { Excalidraw }] = await Promise.all([
		import('react'),
		import('react-dom/client'),
		import('@excalidraw/excalidraw')
	]);
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
