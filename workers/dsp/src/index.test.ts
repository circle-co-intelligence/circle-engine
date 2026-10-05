import { describe, it, expect } from 'vitest';
import { b64, mapProviderEvent } from './index';

describe('b64', () => {
	it('encodes PCM frames to base64', () => {
		const buf = new Uint8Array([0, 1, 2, 255]).buffer;
		expect(b64(buf)).toBe(btoa(String.fromCharCode(0, 1, 2, 255)));
	});

	it('handles frames larger than the subarray chunk', () => {
		const buf = new Uint8Array(0x9000).fill(7).buffer;
		expect(b64(buf)).toBe(btoa(String.fromCharCode(...new Uint8Array(0x9000).fill(7))));
	});
});

describe('mapProviderEvent — openai', () => {
	it('maps completed transcription to a final transcript', () => {
		expect(
			mapProviderEvent('openai', {
				type: 'conversation.item.input_audio_transcription.completed',
				transcript: 'Hallo, how are you? Muy bien.'
			})
		).toEqual({ t: 'transcript', text: 'Hallo, how are you? Muy bien.', final: true });
	});

	it('maps deltas to partial transcripts', () => {
		expect(
			mapProviderEvent('openai', {
				type: 'conversation.item.input_audio_transcription.delta',
				delta: 'partial wo'
			})
		).toEqual({ t: 'transcript', text: 'partial wo', final: false });
	});

	it('surfaces provider errors as events', () => {
		expect(
			mapProviderEvent('openai', {
				type: 'error',
				error: { code: 'insufficient_quota' }
			})
		).toEqual({ t: 'event', event: 'provider-error:insufficient_quota', end: true });
	});

	it('drops unrelated realtime messages', () => {
		expect(mapProviderEvent('openai', { type: 'session.created' })).toBeNull();
		expect(mapProviderEvent('openai', { type: 'input_audio_buffer.committed' })).toBeNull();
	});
});

describe('mapProviderEvent — speechmatics/assemblyai unchanged', () => {
	it('speechmatics AddTranscript still maps', () => {
		expect(
			mapProviderEvent('speechmatics', {
				message: 'AddTranscript',
				results: [
					{ type: 'word', alternatives: [{ content: 'hello', speaker: 'S1' }] },
					{ type: 'word', alternatives: [{ content: 'world' }] }
				]
			})
		).toEqual({ t: 'transcript', text: 'hello world', final: true, speaker: 'S1' });
	});

	it('assemblyai FinalTranscript still maps', () => {
		expect(
			mapProviderEvent('assemblyai', { message_type: 'FinalTranscript', text: 'hi' })
		).toEqual({ t: 'transcript', text: 'hi', final: true, speaker: undefined });
	});
});
