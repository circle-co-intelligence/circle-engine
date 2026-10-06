/**
 * modelHost.ts — where on-device model bytes come from.
 *
 * Two lanes, decided at build time (VITE_CIC_MODELS_BASE):
 *
 *  1. Free-egress bucket (production): models live in a public R2 bucket on
 *     the free-egress plane — unpaid users stay fully functional and the
 *     operator never bills for the bytes. whisper transformers.js files at
 *     <base>/hf/<repo>/resolve/<rev>/<file>, sherpa tarballs at
 *     <base>/pack/<key>, onnxruntime wasm at <base>/ort/<file>.
 *
 *  2. ai-gateway proxies (self-host / fallback): /ai/hf, /ai/pack, /ai/ort.
 *     On metered deploys the gateway only proxies for a funded room — the
 *     room code rides in the URL (hf: first path segment; pack/ort: ?room=)
 *     because model fetchers can't attach auth headers. Unfunded → 402.
 *
 * Room code is set once per join via setModelRoom(); loaders read it lazily
 * so the ear/caption lanes pick it up without threading params everywhere.
 */

const ENV = import.meta.env as Record<string, string | undefined>;
const MODELS_BASE = (ENV.VITE_CIC_MODELS_BASE ?? '').replace(/\/+$/, '');
const aiBase = ENV.VITE_CIC_AI_ENDPOINT;
const edgeBase = aiBase?.replace(/\/ai\/?$/, '') ?? '';

let room = '';
export function setModelRoom(code: string) {
	room = code;
}

/** transformers.js remoteHost — appended verbatim before
 *  <repo>/resolve/<rev>/<file> */
export function hfBase(): string {
	if (MODELS_BASE) return `${MODELS_BASE}/hf/`;
	if (room) return `${edgeBase}/ai/hf/${encodeURIComponent(room)}/`;
	return `${edgeBase}/ai/hf/`;
}

/** onnxruntime wasm/mjs loader URL */
export function ortUrl(file: string): string {
	if (MODELS_BASE) return `${MODELS_BASE}/ort/${file}`;
	return `${edgeBase}/ai/ort/${file}${room ? `?room=${encodeURIComponent(room)}` : ''}`;
}

/** sherpa tarball / gguf pack URL — null when no lane is configured */
export function packUrl(key: string): string | null {
	if (MODELS_BASE) return `${MODELS_BASE}/pack/${key}`;
	if (!edgeBase) return null;
	return `${edgeBase}/ai/pack/${key}${room ? `?room=${encodeURIComponent(room)}` : ''}`;
}

/** true when model bytes come from the free-egress bucket, not the worker */
export function modelsFreeHosted(): boolean {
	return !!MODELS_BASE;
}
