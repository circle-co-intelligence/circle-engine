import { describe, expect, it } from 'vitest';
import { normalizeExtmaps } from './sdp';

const sdp = (lines: string[]) => lines.join('\r\n');
const extmaps = (s: string) => s.split('\r\n').filter((l) => l.startsWith('a=extmap:'));
const idOf = (lines: string[], uri: string) =>
	lines.filter((l) => l.includes(uri)).map((l) => Number(/^a=extmap:(\d+)/.exec(l)?.[1]));

describe('normalizeExtmaps', () => {
	it('rewrites known URIs to canonical ids, consistent across m-lines', () => {
		// Firefox numbers per m-line: same id, different URI — the collision
		// Chrome rejects as "RTP extension ID reassignment not supported".
		const out = normalizeExtmaps(sdp([
			'm=audio 9 UDP/TLS/RTP/SAVPF 0',
			'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
			'a=extmap:3 urn:ietf:params:rtp-hdrext:sdes:mid',
			'a=extmap:7 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
			'm=video 9 UDP/TLS/RTP/SAVPF 96',
			'a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
			'a=extmap:7 urn:ietf:params:rtp-hdrext:sdes:mid'
		]));
		const ex = extmaps(out);
		// every m-line binds the same id to the same URI
		expect(ex).toContain('a=extmap:3 urn:ietf:params:rtp-hdrext:sdes:mid');
		expect(ex).toContain('a=extmap:7 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01');
		expect(ex.filter((l) => l.includes('sdes:mid'))).toHaveLength(2);
		expect(ex.filter((l) => l.includes('holmer'))).toHaveLength(2);
	});

	it('keeps the simulcast/rid family on fixed canonical ids — dropping or renumbering them breaks simulcast offers', () => {
		const out = normalizeExtmaps(sdp([
			'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
			'a=extmap:4 urn:ietf:params:rtp-hdrext:rid',
			'a=extmap:5 urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id',
			'a=extmap:6 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
			'a=rid:0 send',
			'a=simulcast: send 0'
		]));
		const ex = extmaps(out);
		expect(ex).toContain('a=extmap:11 urn:ietf:params:rtp-hdrext:rid');
		expect(ex).toContain('a=extmap:12 urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id');
		expect(ex).toContain('a=extmap:4 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time');
	});

	it('gives unknown URIs a stable id — same URI, same id, regardless of the desc', () => {
		const uri = 'http://example.com/experimental-ext';
		const a = extmaps(normalizeExtmaps(sdp([
			'm=audio 9 UDP/TLS/RTP/SAVPF 0',
			`a=extmap:9 ${uri}`,
			'a=extmap:4 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time'
		])));
		// different desc, different id for the same URI, different URI mix
		const b = extmaps(normalizeExtmaps(sdp([
			'm=video 9 UDP/TLS/RTP/SAVPF 96',
			`a=extmap:12 ${uri}`,
			'a=extmap:2 urn:ietf:params:rtp-hdrext:csrc-audio-level'
		])));
		expect(idOf(a, uri)).toEqual(idOf(b, uri));
	});

	it('never binds two URIs to the same id inside one desc', () => {
		const out = normalizeExtmaps(sdp([
			'm=video 9 UDP/TLS/RTP/SAVPF 96',
			'a=extmap:4 http://example.com/a',
			'a=extmap:4 http://example.com/b',
			'a=extmap:4 http://example.com/c',
			'a=extmap:4 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time'
		]));
		const ids = extmaps(out).map((l) => Number(/^a=extmap:(\d+)/.exec(l)?.[1]));
		expect(new Set(ids).size).toBe(ids.length);
		expect(out).toContain('a=extmap:4 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time');
	});
});
