/**
 * Local translation lane — runs the same vendored wllama/SmolLM2 model Milo
 * uses, so translation never leaves the device and needs no new downloads.
 * Lazy: the ~100MB GGUF loads on first translation request, not on join.
 */
import { Wllama } from '@wllama/wllama';
import { base } from '$app/paths';
import manifest from '../../../models/manifest.json';

const LOCAL_MODEL = `${base}/models/llm/SmolLM2-135M-Instruct-Q4_K_M.gguf`;
const REMOTE_MODEL = (manifest.packs as Record<string, { url?: string }>)['llm']?.url ?? '';

let modelUrlCache: string | null = null;
/** local weights when vendored (dev/self-host), upstream HF resolve URL otherwise */
export async function llmModelUrl(): Promise<string> {
	if (modelUrlCache) return modelUrlCache;
	const local = new URL(LOCAL_MODEL, location.origin).href;
	modelUrlCache = await fetch(local, { method: 'HEAD' })
		.then((r) => (r.ok ? local : REMOTE_MODEL))
		.catch(() => REMOTE_MODEL);
	return modelUrlCache;
}

export const WLLAMA_WASM = {
	'single-thread/wllama.wasm': `${base}/wllama/wllama-single.wasm`,
	'multi-thread/wllama.wasm': `${base}/wllama/wllama-multi.wasm`
} as const;

const LANG_NAMES: Record<string, string> = {
	en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
	pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', sv: 'Swedish', da: 'Danish',
	nb: 'Norwegian', fi: 'Finnish', cs: 'Czech', ja: 'Japanese', zh: 'Chinese',
	ko: 'Korean', ar: 'Arabic', hi: 'Hindi', ru: 'Russian', uk: 'Ukrainian',
	tr: 'Turkish', el: 'Greek', he: 'Hebrew'
};

let llm: Wllama | null = null;
let loading: Promise<Wllama | null> | null = null;

async function getLlm(): Promise<Wllama | null> {
	if (llm) return llm;
	if (!loading) {
		loading = (async () => {
			try {
				const w = new Wllama(WLLAMA_WASM);
				// wllama fetches inside a blob worker — relative URLs don't
				// resolve there, so hand it an absolute one
				await w.loadModelFromUrl(await llmModelUrl(), { n_ctx: 2048 });
				llm = w;
				return w;
			} catch (e) {
				console.warn('[translate] wllama load failed:', e);
				return null; // model not vendored — caller reports honestly
			}
		})();
	}
	return loading;
}

// wllama runs a single completion session — concurrent createChatCompletion
// calls corrupt/fail each other, and several fanout instances share this model.
// Serialize at the model boundary so a busy engine never drops a translation.
let completion: Promise<unknown> = Promise.resolve();

/** translate a transcript line; returns null when the local model is absent */
export async function translateText(text: string, toLang: string, fromLang = 'English'): Promise<string | null> {
	const w = await getLlm();
	if (!w) return null;
	const to = LANG_NAMES[toLang] ?? toLang;
	const run = completion.then(() =>
		w.createChatCompletion(
			[
				{
					role: 'system',
					content: `You translate ${fromLang} into ${to}. Output ONLY the ${to} translation — no notes, no quotes, no alternatives.`
				},
				{ role: 'user', content: text }
			],
			{ nPredict: 256 }
		)
	);
	completion = run.catch(() => {});
	try {
		const out = await run;
		// the 135M model rambles past the translation — a blank line marks
		// where it starts continuing instead of translating
		return out.split(/\n\s*\n/)[0].trim() || null;
	} catch {
		return null;
	}
}
