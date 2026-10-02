import { describe, it, expect } from 'vitest';
import { elect, electAll, type Capability } from './auction';

const cap = (peerId: string, over: Partial<Capability> = {}): Capability => ({
	peerId, cpuScore: 8, memoryGB: 8, batterySaver: false,
	webgpu: true, models: [], uplinkKbps: 5000, isRecorderDevice: false, ...over
});

describe('role auction', () => {
	it('milo-brain prefers webgpu + llm model cached', () => {
		const weak = cap('weak', { webgpu: false, models: [] });
		const strong = cap('strong', { webgpu: true, models: ['llm'] });
		expect(elect([weak, strong], 'milo-brain')).toBe('strong');
	});

	it('recorder-primary prefers dedicated recorder device', () => {
		const laptop = cap('laptop');
		const dedicated = cap('tablet', { isRecorderDevice: true, memoryGB: 2 });
		expect(elect([laptop, dedicated], 'recorder-primary')).toBe('tablet');
	});

	it('standby excludes the primary winner', () => {
		const roles = electAll([cap('a', { isRecorderDevice: true }), cap('b')]);
		expect(roles['recorder-primary']).toBe('a');
		expect(roles['recorder-standby']).toBe('b');
		expect(roles['recorder-standby']).not.toBe(roles['recorder-primary']);
	});

	it('ties break deterministically by peerId', () => {
		const r1 = electAll([cap('b'), cap('a')]);
		const r2 = electAll([cap('a'), cap('b')]);
		expect(r1).toEqual(r2); // order-independent — every client agrees
	});

	it('bw-allocator prefers the healthiest uplink, avoids battery saver', () => {
		const mobile = cap('mobile', { uplinkKbps: 800, batterySaver: true });
		const desktop = cap('desktop', { uplinkKbps: 9000 });
		expect(elect([mobile, desktop], 'bw-allocator')).toBe('desktop');
		const roles = electAll([mobile, desktop]);
		expect(roles['bw-allocator']).toBe('desktop');
	});
});
