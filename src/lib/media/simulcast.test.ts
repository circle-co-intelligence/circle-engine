import { describe, it, expect } from 'vitest';
import { layersFor, applyPullHint } from './simulcast';

function fakePc(encodings: RTCRtpEncodingParameters[]) {
	const calls: RTCRtpSendParameters[] = [];
	const sender = {
		track: { kind: 'video' } as MediaStreamTrack,
		getParameters: () => ({ encodings }) as RTCRtpSendParameters,
		setParameters: (p: RTCRtpSendParameters) => {
			calls.push(p);
			return Promise.resolve();
		}
	} as unknown as RTCRtpSender;
	const pc = { getSenders: () => [sender] } as unknown as RTCPeerConnection;
	return { pc, calls, encodings };
}

describe('layersFor', () => {
	it('full budget activates every layer', () => {
		expect(layersFor(2000)).toEqual({ f: true, h: true, q: true });
	});
	it('mid budget drops the f layer', () => {
		expect(layersFor(700)).toEqual({ f: false, h: true, q: true });
	});
	it('tight budget keeps only q', () => {
		expect(layersFor(200)).toEqual({ f: false, h: false, q: true });
	});
	it('explicit rid selects exactly that layer', () => {
		expect(layersFor('h')).toEqual({ f: false, h: true, q: false });
	});
	it('none kills video entirely', () => {
		expect(layersFor('none')).toEqual({ f: false, h: false, q: false });
	});
});

describe('applyPullHint', () => {
	it('toggles rid encodings per the requested layer', () => {
		const enc = [{ rid: 'f' }, { rid: 'h' }, { rid: 'q' }] as RTCRtpEncodingParameters[];
		const { pc, calls } = fakePc(enc);
		applyPullHint(pc, 'q');
		expect(enc.map((e) => e.active)).toEqual([false, false, true]);
		expect(calls).toHaveLength(1);
	});
	it('none disables every encoding', () => {
		const enc = [{ rid: 'f' }, { rid: 'h' }] as RTCRtpEncodingParameters[];
		const { pc } = fakePc(enc);
		applyPullHint(pc, 'none');
		expect(enc.every((e) => e.active === false)).toBe(true);
	});
	it('numeric budget on single-encoding senders clamps bitrate instead', () => {
		const enc = [{}] as RTCRtpEncodingParameters[];
		const { pc } = fakePc(enc);
		applyPullHint(pc, 300);
		expect(enc[0].maxBitrate).toBe(300_000);
		expect(enc[0].active).toBe(true);
	});
	it('none on single-encoding disables the sender', () => {
		const enc = [{}] as RTCRtpEncodingParameters[];
		const { pc } = fakePc(enc);
		applyPullHint(pc, 'none');
		expect(enc[0].active).toBe(false);
	});
});
