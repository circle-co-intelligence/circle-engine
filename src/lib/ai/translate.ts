/**
 * Local translation lane — runs the same vendored wllama/SmolLM2 model Milo
 * uses, so translation never leaves the device and needs no new downloads.
 * Lazy: the ~270MB GGUF loads on first translation request, not on join.
 */
import { Wllama } from '@wllama/wllama';
import { base } from '$app/paths';
import manifest from '../../../models/manifest.json';
import { emitModel } from './modelStatus';
import { packUrl } from './modelHost';

const LOCAL_MODEL = `${base}/models/llm/SmolLM2-360M-Instruct-Q4_K_M.gguf`;
// model bytes resolve through modelHost — the free-egress bucket on metered
// deploys, else the /ai/pack proxy carrying the room code for its
// funded-pool gate; HF's resolve CDN stays the no-lane last resort
function remoteModel(): string {
	return (
		packUrl('llm') ??
		(manifest.packs as Record<string, { url?: string }>)['llm']?.url ??
		''
	);
}

let modelUrlCache: string | null = null;
/** local weights when vendored (dev/self-host), the model lane otherwise */
export async function llmModelUrl(): Promise<string> {
	if (modelUrlCache) return modelUrlCache;
	const local = new URL(LOCAL_MODEL, location.origin).href;
	const remote = remoteModel();
	modelUrlCache = await fetch(local, { method: 'HEAD' })
		.then((r) => (r.ok ? local : remote))
		.catch(() => remote);
	return modelUrlCache;
}

export const WLLAMA_WASM = {
	'single-thread/wllama.wasm': `${base}/wllama/wllama-single.wasm`,
	'multi-thread/wllama.wasm': `${base}/wllama/wllama-multi.wasm`
} as const;

// ISO 639-1/whisper code → English name, for prompt quality. Unknown
// codes fall through verbatim — translation is not limited to this table.
const LANG_NAMES: Record<string, string> = {
	af: 'Afrikaans', am: 'Amharic', ar: 'Arabic', as: 'Assamese',
	az: 'Azerbaijani', ba: 'Bashkir', be: 'Belarusian', bg: 'Bulgarian',
	bn: 'Bengali', bo: 'Tibetan', br: 'Breton', bs: 'Bosnian',
	ca: 'Catalan', cs: 'Czech', cy: 'Welsh', da: 'Danish',
	de: 'German', el: 'Greek', en: 'English', es: 'Spanish',
	et: 'Estonian', eu: 'Basque', fa: 'Persian', fi: 'Finnish',
	fo: 'Faroese', fr: 'French', gl: 'Galician', gu: 'Gujarati',
	ha: 'Hausa', haw: 'Hawaiian', he: 'Hebrew', hi: 'Hindi',
	hr: 'Croatian', ht: 'Haitian Creole', hu: 'Hungarian', hy: 'Armenian',
	id: 'Indonesian', is: 'Icelandic', it: 'Italian', ja: 'Japanese',
	jw: 'Javanese', ka: 'Georgian', kk: 'Kazakh', km: 'Khmer',
	kn: 'Kannada', ko: 'Korean', la: 'Latin', lb: 'Luxembourgish',
	ln: 'Lingala', lo: 'Lao', lt: 'Lithuanian', lv: 'Latvian',
	mg: 'Malagasy', mi: 'Maori', mk: 'Macedonian', ml: 'Malayalam',
	mn: 'Mongolian', mr: 'Marathi', ms: 'Malay', mt: 'Maltese',
	my: 'Burmese', ne: 'Nepali', nl: 'Dutch', nn: 'Nynorsk',
	no: 'Norwegian', nb: 'Norwegian', oc: 'Occitan', pa: 'Punjabi',
	pl: 'Polish', ps: 'Pashto', pt: 'Portuguese', ro: 'Romanian',
	ru: 'Russian', sa: 'Sanskrit', sd: 'Sindhi', si: 'Sinhala',
	sk: 'Slovak', sl: 'Slovenian', sn: 'Shona', so: 'Somali',
	sq: 'Albanian', sr: 'Serbian', su: 'Sundanese', sv: 'Swedish',
	sw: 'Swahili', ta: 'Tamil', te: 'Telugu', tg: 'Tajik',
	th: 'Thai', tk: 'Turkmen', tl: 'Tagalog', tr: 'Turkish',
	tt: 'Tatar', uk: 'Ukrainian', ur: 'Urdu', uz: 'Uzbek',
	vi: 'Vietnamese', yi: 'Yiddish', yo: 'Yoruba', zh: 'Chinese',
	yue: 'Cantonese'
};

/** ISO code → English display name for prompts; codes we don't name pass
 *  through verbatim (the model still gets a usable instruction) */
export function langName(code: string): string {
	return LANG_NAMES[code] ?? code;
}

let llm: Wllama | null = null;
let loading: Promise<Wllama | null> | null = null;

async function getLlm(): Promise<Wllama | null> {
	if (llm) return llm;
	if (!loading) {
		loading = (async () => {
			try {
				emitModel('llm', 'loading');
				const w = new Wllama(WLLAMA_WASM);
				// wllama fetches inside a blob worker — relative URLs don't
				// resolve there, so hand it an absolute one
				await w.loadModelFromUrl(await llmModelUrl(), { n_ctx: 2048 });
				llm = w;
				emitModel('llm', 'ready');
				return w;
			} catch (e) {
				console.warn('[translate] wllama load failed:', e);
				emitModel('llm', 'error');
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
			{
				nPredict: 256,
				// low temp + repeat penalty: the small instruct model otherwise
				// rambles/echoes past the translation
				sampling: { temp: 0.3, top_p: 0.9, top_k: 40, penalty_repeat: 1.15, penalty_last_n: 64 }
			}
		)
	);
	completion = run.catch(() => {});
	try {
		const out = await run;
		// the small instruct model can ramble past the translation — a blank
		// line marks where it starts continuing instead of translating
		return out.split(/\n\s*\n/)[0].trim() || null;
	} catch {
		return null;
	}
}
