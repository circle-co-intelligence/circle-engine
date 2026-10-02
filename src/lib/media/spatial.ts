/**
 * spatial.ts — receive-side audio shaping, one WebAudio chain per remote
 * voice, applied on the pull leg before a track reaches the frontend:
 *
 *   remote track → MediaStreamAudioSource → DynamicsCompressor → StereoPanner → dest
 *
 *   DynamicsCompressor = loudness normalization — every voice lands at the
 *   same level, whoever's mic is hot or quiet (nobody else normalizes
 *   across talkers).
 *   StereoPanner = spatial placement — the seat's angle in the circle maps
 *   to a stereo position, so a voice comes from where it sits.
 *
 * Both are opt-in via room config and degrade silently on browsers without
 * the full AudioContext feature set.
 */

interface ProcEntry {
	ctx: AudioContext;
	pan: StereoPannerNode;
	dest: MediaStreamAudioDestinationNode;
	track: MediaStreamTrack;
}

let ctx: AudioContext | null = null;
const procs = new Map<string, ProcEntry>();

function audioCtx(): AudioContext | null {
	try {
		return (ctx ??= new AudioContext({ sampleRate: 48000 }));
	} catch {
		return null;
	}
}

export interface SpatialOpts {
	/** normalize loudness across talkers */
	loudness?: boolean;
	/** seat angle in radians → stereo pan; undefined = center */
	angle?: number;
}

/** process a remote audio track; returns the shaped track (or the source) */
export function shapeRemoteAudio(
	key: string,
	track: MediaStreamTrack,
	opts: SpatialOpts
): MediaStreamTrack {
	if (track.kind !== 'audio') return track;
	const wantPan = opts.angle !== undefined && Math.abs(opts.angle) > 0.01;
	if (!opts.loudness && !wantPan) return track;
	const ac = audioCtx();
	if (!ac) return track;
	let p = procs.get(key);
	if (!p) {
		const src = ac.createMediaStreamSource(new MediaStream([track]));
		const comp = ac.createDynamicsCompressor();
		comp.threshold.value = -18;
		comp.ratio.value = 4;
		comp.attack.value = 0.004;
		comp.release.value = 0.24;
		const pan = ac.createStereoPanner();
		const dest = ac.createMediaStreamDestination();
		src.connect(comp);
		if (opts.loudness) comp.connect(pan);
		else src.connect(pan);
		pan.connect(dest);
		p = { ctx: ac, pan, dest, track: dest.stream.getAudioTracks()[0] };
		procs.set(key, p);
	}
	// seat angle → pan: 0 rad = ahead-center, ±π/2 = hard left/right
	p.pan.pan.value = opts.angle === undefined ? 0 : Math.sin(opts.angle);
	return p.track;
}

/** seat index → angle around the listener, spread across the front 240° */
export function seatAngle(seatIndex: number, seatCount: number): number {
	if (seatCount <= 1) return 0;
	const spread = (Math.PI * 2) / 3; // ±120°
	return -spread + (2 * spread * seatIndex) / (seatCount - 1);
}

export function dropSpatial(key: string) {
	procs.get(key)?.track.stop();
	procs.delete(key);
}
