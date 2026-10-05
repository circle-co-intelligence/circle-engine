import { describe, it, expect, vi } from 'vitest';
import { WhisperCaptionPipeline } from './whisper';

const LANG_MAP = {'<|en|>': 50259, '<|de|>': 50261, '<|fr|>': 50263};

function fakeAsr(text: string, langTokenId: number) {
	const calls: { language?: string; task?: string }[] = [];
	const asr = Object.assign(
		async (_audio: Float32Array, opts?: Record<string, unknown>) => {
			calls.push({ language: opts?.language as string, task: opts?.task as string });
			return { text };
		},
		{
			calls,
			processor: async () => ({ input_features: {} }),
			model: {
				generation_config: { lang_to_id: LANG_MAP, decoder_start_token_id: 0 },
				generate: async () => ({ sequences: { data: [0, langTokenId] } })
			}
		}
	);
	return asr;
}

const speech = (ms: number, amp = 0.5) => {
	const f = new Float32Array(Math.floor((ms / 1000) * 16000));
	f.fill(amp);
	return f;
};
const silence = (ms: number) => new Float32Array(Math.floor((ms / 1000) * 16000));

async function makePipe(text = 'Hallo welt', langTok = 50261) {
	const p = new WhisperCaptionPipeline();
	const asr = fakeAsr(text, langTok);
	(p as unknown as { asr: unknown }).asr = asr;
	const segs: { text: string; final: boolean; lang?: string }[] = [];
	p.onSegment = (s) => segs.push({ text: s.text, final: s.final, lang: s.lang });
	return { p, asr, segs };
}

describe('WhisperCaptionPipeline — segmentation', () => {
	it('emits a partial after ~3s of speech and a final after ~0.9s silence', async () => {
		const { p, segs } = await makePipe();
		for (let i = 0; i < 20; i++) p.push(speech(300));
		await vi.waitFor(() => expect(segs.some((s) => !s.final)).toBe(true));
		p.push(silence(1200));
		await vi.waitFor(() => expect(segs.some((s) => s.final)).toBe(true));
	});

	it('drops silence before speech starts', async () => {
		const { p, asr, segs } = await makePipe();
		p.push(silence(5000));
		await new Promise((r) => setTimeout(r, 50));
		expect(segs.length).toBe(0);
		expect(asr.calls.length).toBe(0);
	});

	it('forces a final at the 24s utterance cap', async () => {
		const { p, segs } = await makePipe();
		for (let i = 0; i < 90; i++) p.push(speech(300));
		await vi.waitFor(() => expect(segs.some((s) => s.final)).toBe(true));
	});

	it('keeps post-final audio belonging to the next utterance', async () => {
		const { p, segs } = await makePipe();
		for (let i = 0; i < 5; i++) p.push(speech(300));
		p.push(silence(1200));
		await vi.waitFor(() => expect(segs.some((s) => s.final)).toBe(true));
		for (let i = 0; i < 12; i++) p.push(speech(300));
		p.push(silence(1200));
		await vi.waitFor(() => expect(segs.filter((s) => s.final).length).toBe(2));
	});
});

describe('WhisperCaptionPipeline — language', () => {
	it('detects the utterance language via the SOT-only first token', async () => {
		const { p, asr, segs } = await makePipe('Bonjour le monde', 50263);
		for (let i = 0; i < 12; i++) p.push(speech(300));
		p.push(silence(1200));
		await vi.waitFor(() => expect(segs.some((s) => s.final)).toBe(true));
		expect(asr.calls[0].language).toBe('fr');
		expect(segs.at(-1)?.lang).toBe('fr');
	});

	it('reuses the detected language for the rest of the utterance', async () => {
		const { p, asr } = await makePipe('text', 50261);
		for (let i = 0; i < 20; i++) p.push(speech(300));
		await vi.waitFor(() => expect(asr.calls.length).toBeGreaterThan(0));
		expect(asr.calls.every((c) => c.language === 'de')).toBe(true);
	});
});
