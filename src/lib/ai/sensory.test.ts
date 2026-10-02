import { describe, it, expect } from 'vitest';
import { mapDirect } from './sensory';

describe('mapDirect — Speechmatics RT → sensory events', () => {
	it('maps AddTranscript to a final diarized transcript', () => {
		const ev = mapDirect({
			message: 'AddTranscript',
			results: [
				{ type: 'word', alternatives: [{ content: 'hello', speaker: 'S2' }] },
				{ type: 'punctuation', alternatives: [{ content: ',' }] },
				{ type: 'word', alternatives: [{ content: 'milo', speaker: 'S2' }] }
			]
		});
		expect(ev).toEqual({ t: 'transcript', text: 'hello milo', final: true, speaker: 'S2' });
	});

	it('returns null for AddTranscript with no words', () => {
		expect(mapDirect({ message: 'AddTranscript', results: [] })).toBeNull();
	});

	it('maps AddPartialTranscript to a non-final transcript', () => {
		const ev = mapDirect({
			message: 'AddPartialTranscript',
			metadata: { transcript: 'partial thought' }
		});
		expect(ev).toEqual({ t: 'transcript', text: 'partial thought', final: false });
	});

	it('maps audio events with start/end', () => {
		expect(mapDirect({ message: 'AudioEventStarted', event_type: 'laughter' })).toEqual({
			t: 'event',
			event: 'laughter',
			end: false
		});
		expect(mapDirect({ message: 'AudioEventEnded', event_type: 'music' })).toEqual({
			t: 'event',
			event: 'music',
			end: true
		});
	});

	it('ignores unrelated provider messages', () => {
		expect(mapDirect({ message: 'RecognitionStarted' })).toBeNull();
		expect(mapDirect({ message: 'EndOfTranscript' })).toBeNull();
		expect(mapDirect({ message: 'Info', type: 'mtu' })).toBeNull();
	});
});
