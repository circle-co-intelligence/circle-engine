import { describe, it, expect } from 'vitest';
import { E2EESession } from './e2ee';

/** minimal RoomHandle stub — E2EESession only reads selfId at construction */
const room = { selfId: 'peer-self' } as never;

describe('per-peer SFrame gating (the iOS<18.4 interop fix)', () => {
	it('a peer with no advertised cap[1] is not transform-covered', () => {
		const e = new E2EESession(room);
		expect(e.peerSupported('peer-iphone')).toBe(false);
		e.addPeerIdentity('peer-iphone', 'a'.repeat(64));
		// covered only when WE can transform too — unsupported runtimes keep it false
		expect(e.peerSupported('peer-iphone')).toBe(e.supported);
	});

	it('publicKeyHex is still available — callers decide whether to advertise', () => {
		const e = new E2EESession(room);
		expect(e.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
	});
});
