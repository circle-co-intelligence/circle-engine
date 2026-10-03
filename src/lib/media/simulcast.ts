/**
 * simulcast.ts — mesh simulcast + per-receiver layer selection.
 *
 * Trystero (and our ws lane) call pc.addTrack(track, stream) internally on
 * each per-peer pc. A guarded prototype patch upgrades VIDEO adds to
 * addTransceiver with a rid ladder [f|h|q] — the same mechanism SFUs use,
 * applied per-mesh-pc. Receivers then pick a layer via 'pull-hint'
 * realtime frames: the sender toggles encoding.active on JUST that peer's
 * pc, which is per-receiver layer selection with no SFU at all.
 *
 * Non-mesh pcs are excluded via skipSimulcast() (the loopback SFU leg —
 * simulcasting pulled tracks back to prod's display pc is pure waste).
 * Screen tracks (contentHint 'detail') stay single-encoding full-res.
 * Browsers without sendEncodings keep one encoding; applyPullHint then
 * degrades to bitrate clamps / active toggles — the semantics hold.
 */

export type PullRid = 'f' | 'h' | 'q' | 'none';

/** sender-side ladder — receivers select one of these via pull-hint */
export const SIM_LAYERS: RTCRtpEncodingParameters[] = [
	{ rid: 'f', maxBitrate: 2_500_000 },
	{ rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 900_000 },
	{ rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 250_000 }
];

const skipped = new WeakSet<RTCPeerConnection>();
const noRid = new WeakSet<RTCPeerConnection>(); // transceiver came up single-encoding
let installed = false;

/** mark a pc as ineligible for the simulcast upgrade (loopback SFU leg) */
export function skipSimulcast(pc: RTCPeerConnection): void {
	skipped.add(pc);
}

export function simulcastPatched(): boolean {
	return installed;
}

/**
 * Patch RTCPeerConnection.prototype.addTrack once. Must run before any
 * mesh pc adds tracks — net/room.ts calls this at module init.
 */
export function installSimulcast(): void {
	if (installed || typeof RTCPeerConnection === 'undefined') return;
	installed = true;
	const orig = RTCPeerConnection.prototype.addTrack;
	RTCPeerConnection.prototype.addTrack = function (
		this: RTCPeerConnection,
		track: MediaStreamTrack,
		...streams: MediaStream[]
	): RTCRtpSender {
		if (track.kind !== 'video' || skipped.has(this) || noRid.has(this)) return orig.call(this, track, ...streams);
		try {
			const tr = this.addTransceiver(track, {
				direction: 'sendrecv', // addTrack semantics — remote may reuse the m-line
				streams,
				sendEncodings: SIM_LAYERS.map((e) => ({ ...e }))
			});
			const enc = tr.sender.getParameters().encodings ?? [];
			if (enc.length < 2 || !enc[0]?.rid) {
				// unsupported browser silently produced a single encoding —
				// normal single-layer send, pull-hints degrade to clamps
				noRid.add(this);
			}
			return tr.sender;
		} catch {
			noRid.add(this);
			return orig.call(this, track, ...streams);
		}
	};
}

/**
 * Which layers should be active toward a peer, given either an explicit
 * rid request or a kbps budget. Returns rid→active for ladder senders.
 */
export function layersFor(hint: PullRid | number): Partial<Record<PullRid, boolean>> {
	if (typeof hint === 'number') {
		const kbps = hint;
		// q is the always-on floor; mid budgets add h; full budgets add f
		return { f: kbps >= 1400, h: kbps >= 500, q: true };
	}
	if (hint === 'none') return { f: false, h: false, q: false };
	return { f: hint === 'f', h: hint === 'h', q: hint === 'q' };
}

/**
 * Apply a receiver's pull-hint (or room budget) to one pc's video senders.
 * Ladder senders toggle .active per rid; single-encoding senders fall back
 * to a bitrate clamp ('none' disables the sender's only encoding).
 */
export function applyPullHint(pc: RTCPeerConnection, hint: PullRid | number): void {
	const want = layersFor(hint);
	const budgetBps = typeof hint === 'number' ? hint * 1000 : null;
	for (const s of pc.getSenders()) {
		if (s.track?.kind !== 'video') continue;
		if ((s.track as MediaStreamTrack & { contentHint?: string }).contentHint === 'detail') continue;
		const p = s.getParameters();
		const encs = p.encodings ?? [];
		if (!encs.length) continue;
		const hasRid = encs.some((e) => e.rid);
		for (const e of encs) {
			if (hasRid) {
				const rid = (e.rid ?? 'f') as PullRid;
				e.active = want[rid] ?? true;
			} else if (budgetBps !== null) {
				e.maxBitrate = Math.min(e.maxBitrate ?? Infinity, Math.max(60_000, budgetBps));
				e.active = true;
			} else if (hint === 'none') {
				e.active = false;
			} else {
				e.active = true;
				e.maxBitrate = { f: 2_500_000, h: 900_000, q: 250_000, none: 0 }[hint] ?? e.maxBitrate;
			}
		}
		s.setParameters(p).catch(() => {});
	}
}
