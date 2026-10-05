import { describe, expect, it } from 'vitest';
import { limitTurnUrls } from './room';

// /api/ice returns one server with six turn/turns URLs — over libnice's
// NICE_CANDIDATE_MAX_TURN_SERVERS, which aborts the WebKitGTK WebProcess.
const broker: RTCIceServer[] = [
	{ urls: 'stun:stun.cloudflare.com:3478' },
	{
		urls: [
			'turn:turn.cloudflare.com:3478?transport=udp',
			'turn:turn.cloudflare.com:3478?transport=tcp',
			'turns:turn.cloudflare.com:5349?transport=tcp',
			'turn:turn.cloudflare.com:443?transport=udp',
			'turn:turn.cloudflare.com:80?transport=tcp',
			'turns:turn.cloudflare.com:443?transport=tcp'
		],
		username: 'u',
		credential: 'c'
	}
];

describe('limitTurnUrls', () => {
	it('keeps one URL per transport family — TLS, udp, tcp — STUN untouched', () => {
		const out = limitTurnUrls(broker, 3);
		expect(out[0].urls).toBe('stun:stun.cloudflare.com:3478');
		const turns = (out[1].urls as string[]).filter((u) => u.startsWith('turn'));
		expect(turns).toHaveLength(3);
		expect(turns).toContain('turns:turn.cloudflare.com:443?transport=tcp');
		expect(turns).toContain('turn:turn.cloudflare.com:443?transport=udp');
		expect(turns).toContain('turn:turn.cloudflare.com:80?transport=tcp');
		// credentials stay attached to the trimmed entry
		expect(out[1].username).toBe('u');
		expect(out[1].credential).toBe('c');
	});

	it('leaves small turn sets alone', () => {
		const small: RTCIceServer[] = [
			{ urls: ['turn:t.example:3478?transport=udp'], username: 'u', credential: 'c' }
		];
		expect(limitTurnUrls(small, 3)[0].urls).toEqual(['turn:t.example:3478?transport=udp']);
	});

	it('counts turn URLs across all entries', () => {
		const multi: RTCIceServer[] = [
			{ urls: ['turn:a:3478?transport=udp', 'turns:a:443?transport=tcp'] },
			{ urls: ['turn:b:3478?transport=udp', 'turn:b:443?transport=tcp'] }
		];
		const out = limitTurnUrls(multi, 3);
		const turns = out.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])).filter((u) =>
			u.startsWith('turn')
		);
		expect(turns).toHaveLength(3);
		expect(turns).toContain('turns:a:443?transport=tcp');
	});
});
