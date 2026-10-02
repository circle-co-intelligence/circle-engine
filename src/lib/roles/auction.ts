/**
 * Capability auction — deterministic role assignment across peers.
 * Roles: milo-brain, milo-voice, recorder-primary, recorder-standby, forwarder.
 * Score is computed identically on every client from announced capabilities;
 * no negotiation round needed. Lease+epoch guards handle failover.
 */

export interface Capability {
	peerId: string;
	cpuScore: number; // navigator.hardwareConcurrency
	memoryGB: number; // navigator.deviceMemory
	batterySaver: boolean; // getBattery().charging === false && level < 0.3
	webgpu: boolean;
	models: string[]; // locally cached model-pack ids
	uplinkKbps: number; // estimate from webrtc-issue-detector
	isRecorderDevice: boolean; // dedicated recorder tab opt-in
}

export type Role =
	| 'milo-brain'
	| 'milo-voice'
	| 'recorder-primary'
	| 'recorder-standby'
	| 'forwarder'
	| 'bw-allocator';

export function scoreFor(cap: Capability, role: Role): number {
	switch (role) {
		case 'milo-brain':
			return (
				cap.cpuScore * 10 +
				cap.memoryGB * 8 +
				(cap.webgpu ? 40 : 0) +
				(cap.models.includes('llm') ? 50 : 0) -
				(cap.batterySaver ? 60 : 0)
			);
		case 'milo-voice':
			return cap.cpuScore * 5 + cap.memoryGB * 4 + (cap.models.includes('tts') ? 50 : 0) - (cap.batterySaver ? 40 : 0);
		case 'recorder-primary':
			return (
				(cap.isRecorderDevice ? 100 : 0) +
				cap.memoryGB * 6 +
				cap.uplinkKbps / 1000 -
				(cap.batterySaver ? 80 : 0)
			);
		case 'recorder-standby':
			// second device — same scoring, different winner via exclusion
			return (cap.isRecorderDevice ? 60 : 0) + cap.memoryGB * 4 + cap.uplinkKbps / 2000;
		case 'forwarder':
			return cap.uplinkKbps / 500 + cap.cpuScore * 2 - (cap.batterySaver ? 100 : 0);
		case 'bw-allocator':
			// the room's bandwidth broker should sit on the healthiest link —
			// it reads everyone's stats and must stay reachable itself
			return cap.uplinkKbps / 200 + cap.cpuScore * 3 + cap.memoryGB * 2 - (cap.batterySaver ? 80 : 0);
	}
}

/** deterministic winner: highest score, tie-broken by peerId */
export function elect(caps: Capability[], role: Role, exclude: Set<string> = new Set()): string | null {
	let best: Capability | null = null;
	for (const c of caps) {
		if (exclude.has(c.peerId)) continue;
		if (!best || scoreFor(c, role) > scoreFor(best, role) ||
			(scoreFor(c, role) === scoreFor(best, role) && c.peerId < best.peerId)) {
			best = c;
		}
	}
	return best?.peerId ?? null;
}

/** assign all roles; standby != primary, voice may equal brain */
export function electAll(caps: Capability[]): Record<Role, string | null> {
	const primary = elect(caps, 'recorder-primary');
	const standby = elect(caps, 'recorder-standby', new Set(primary ? [primary] : []));
	const brain = elect(caps, 'milo-brain');
	return {
		'recorder-primary': primary,
		'recorder-standby': standby,
		'milo-brain': brain,
		'milo-voice': elect(caps, 'milo-voice'),
		forwarder: elect(caps, 'forwarder'),
		'bw-allocator': elect(caps, 'bw-allocator')
	};
}
