/**
 * SfuLoopback — the SFU node, in-browser. The production frontend treats us
 * as its media server over a SINGLE RTCPeerConnection: it sends `publish`
 * (SDP offer containing its mic/cam/screen transceivers) and `subscribe`
 * (wanted pull tracks); we answer publish and drive renegotiation offers for
 * pulls — all on one shared pc, so our offer m-lines must preserve the
 * transceiver order established by their publish offer.
 *
 * Both PCs live in this page — host candidates connect over loopback
 * instantly, no STUN/TURN needed. Received publish tracks are relayed into
 * the Trystero mesh; mesh streams are offered back as pull m-lines.
 */
import type { RoomSession } from '../state/room.svelte';
import { skipSimulcast } from '../media/simulcast';
import { normalizeExtmaps } from '../net/sdp';

type Frame = Record<string, unknown>;
interface BridgeLike {
	frame(f: Frame): void;
	readonly isOpen: boolean;
}

const RTC_CFG: RTCConfiguration = { iceServers: [] }; // loopback — host candidates only

export class SfuLoopback {
	/** optional receive-side shaping (spatial pan + loudness norm) — set by RoomSession */
	shape?: (sessionId: string, track: MediaStreamTrack) => MediaStreamTrack;
	private pc: RTCPeerConnection | null = null;
	private wanted = new Map<string, { kind: string; trackName: string }>(); // sessionId -> pull request
	private negotiating = false;
	private pendingOffer = false;
	private publishInFlight = false;
	private pullTimer: number | null = null;
	private senderBySession = new Map<string, RTCRtpSender>(); // sessionId -> pull sender
	private session: RoomSession | null = null;
	private sentSessionIds = new Set<string>(); // announced in sfu-pull
	private pullMidSession = new Map<string, string>(); // mid -> sessionId (ours)
	// shaped audio tracks are wrapped copies — remember which sessionId each
	// belongs to so the pulls[] announcement and sessionIdForTrack resolve it
	private shapedTrackSession = new WeakMap<MediaStreamTrack, string>();
	private shapedBySource = new WeakMap<MediaStreamTrack, MediaStreamTrack>();

	constructor(private bridge: BridgeLike) {}

	bind(session: RoomSession) {
		this.session = session;
	}

	private ensurePc(): RTCPeerConnection {
		if (this.pc) return this.pc;
		const pc = new RTCPeerConnection(RTC_CFG);
		// pulls head to prod's display pc — rid layers on this leg are waste
		skipSimulcast(pc);
		pc.ontrack = (ev) => {
			// frontend's captured media — relay to the mesh. Prod's publish
			// offer also carries placeholder m-lines (screenshare slots) whose
			// receiver tracks arrive muted; publishing them makes the mesh
			// transmit black video that outranks the real track in remote
			// remoteStreams merges. Publish only unmuted tracks, and arm the
			// placeholder to publish on its first unmute instead.
			const publish = () => {
				const live = (ev.streams[0]?.getTracks() ?? [ev.track]).filter((t) => !t.muted);
				if (live.length) this.session?.publishLocal(new MediaStream(live));
			};
			publish();
			if (ev.track.muted) ev.track.addEventListener('unmute', publish, { once: true });
		};
		pc.onicecandidate = () => {}; // candidates embedded after gathering
		pc.onconnectionstatechange = () =>
			console.debug('[sfu] pc conn', pc.connectionState, '| ice', pc.iceConnectionState, '| sig', pc.signalingState);
		this.pc = pc;
		return pc;
	}

	// ---- publish leg: frontend offers its local mic/cam/screen to us ----
	publishReady(_connectionId: string, _requestId: string) {}

	async publish(sdpOffer: string, connectionId?: string, requestId?: string) {
		if (!sdpOffer) return;
		const pc = this.ensurePc();
		this.publishInFlight = true;
		try {
			// glare: prod's publish wins over a pull offer we have in flight —
			// prod's pc is impolite (its sfu-offer handler has no rollback), so
			// we must never offer while a publish exchange could be open
			if (pc.signalingState !== 'stable') {
				await pc.setLocalDescription({ type: 'rollback' });
				// our in-flight pull offer is dead — re-offer once stable
				this.negotiating = false;
				this.pendingOffer = true;
			}
			// Firefox prod publish offers carry per-m-line extmap ids that
			// collide under BUNDLE — Chromium rejects them outright (see sdp.ts)
			await pc.setRemoteDescription({ type: 'offer', sdp: normalizeExtmaps(sdpOffer) });
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);
			await iceGathered(pc);
			this.bridge.frame({
				t: 'sfu-answer',
				sdp: pc.localDescription?.sdp ?? answer.sdp,
				connectionId,
				requestId
			});
		} catch (e) {
			console.debug('[sfu] publish failed', e);
			this.publishInFlight = false;
			return;
		}
		// prod applies our answer asynchronously — hold pull offers a beat so an
		// sfu-offer can't land while its pc is still have-local-offer
		window.setTimeout(() => {
			this.publishInFlight = false;
			if (this.wanted.size || this.pendingOffer) void this.negotiatePull(connectionId ?? '');
		}, 400);
	}

	/** interface parity with CloudSfu — mesh senders clamp via setParameters instead */
	async clampPulls(_maxBitrate: number | null) {}

	// ---- pull leg: we offer mesh tracks to the frontend ----
	subscribe(tracks: { sessionId: string; trackName?: string; kind?: string; ownerId?: string }[], connectionId: string) {
		for (const t of tracks) {
			const kind = t.kind ?? t.sessionId.split(':')[1] ?? 'audio';
			this.wanted.set(t.sessionId, { kind, trackName: t.trackName ?? kind });
		}
		void this.negotiatePull(connectionId);
	}

	answer(sdp: string, _connectionId: string) {
		const pc = this.pc;
		// only valid while we hold an outstanding offer — a stale/duplicate
		// answer on a stable pc throws and churns prod's media stack
		if (pc && pc.signalingState === 'have-local-offer')
			pc.setRemoteDescription({ type: 'answer', sdp: normalizeExtmaps(sdp) }).catch(() => {});
		this.negotiating = false;
		if (this.pendingOffer) {
			this.pendingOffer = false;
			void this.negotiatePull(_connectionId);
		}
	}

	/** bridge calls this whenever session.remoteStreams changes */
	notifyStreams() {
		if (!this.session) return;
		const available = this.availableTracks();
		const fresh = available.filter((t) => !this.sentSessionIds.has(t.sessionId));
		if (fresh.length) {
			for (const t of fresh) this.sentSessionIds.add(t.sessionId);
			this.bridge.frame({ t: 'sfu-pull', tracks: fresh });
		}
		// only renegotiate if a wanted pull actually lacks a sender for its
		// track — remoteStreams can fire again with no real track change
		// (trystero keepalive/renegotiation), and unconditionally offering
		// here forces a full SFU renegotiation on every such no-op firing.
		// Repeated enough, prod's client reads that churn as an unstable
		// media connection and reconnects its whole room socket.
		if (!this.pc) return;
		// a replaced track object (mesh reconnect) swaps into its existing
		// sender without renegotiation — only a genuinely unsent track needs an offer
		let needsOffer = false;
		for (const sessionId of this.wanted.keys()) {
			const track = this.trackFor(sessionId);
			const sender = this.senderBySession.get(sessionId);
			if (track && sender && sender.track !== track) {
				void sender.replaceTrack(track).catch(() => {});
				continue;
			}
			if (track && !sender) { needsOffer = true; break; }
		}
		if (needsOffer) void this.negotiatePull('');
	}

	private trackFor(sessionId: string): MediaStreamTrack | null {
		const s = this.session;
		if (!s) return null;
		const [peerId, kind] = sessionId.split(':');
		const stream = s.remoteStreams[peerId];
		// prefer a live (unmuted) track — a peer that re-published can leave a
		// stale/muted placeholder of the same kind in the merged stream
		const track =
			stream?.getTracks().find((t) => t.kind === kind && !t.muted) ??
			stream?.getTracks().find((t) => t.kind === kind) ??
			null;
		if (!track || kind !== 'audio' || !this.shape) return track;
		// memoize per source track — shape() allocates a new MediaStreamTrack
		// every call, and an un-memoized return would trip notifyStreams'
		// sender.track !== track check into a replaceTrack on every firing
		let shaped = this.shapedBySource.get(track);
		if (!shaped) {
			shaped = this.shape(sessionId, track);
			if (shaped !== track) {
				this.shapedTrackSession.set(shaped, sessionId);
				this.shapedBySource.set(track, shaped);
			}
		}
		return shaped;
	}

	private availableTracks(): { sessionId: string; trackName: string; kind: string; ownerId: string }[] {
		const s = this.session;
		if (!s) return [];
		const out = [];
		for (const [peerId, stream] of Object.entries(s.remoteStreams))
			for (const track of stream.getTracks())
				out.push({ sessionId: `${peerId}:${track.kind}`, trackName: track.kind, kind: track.kind, ownerId: peerId });
		return out;
	}

	private negotiatePull(connectionId: string) {
		// prod's pc is impolite: an sfu-offer arriving while it holds a local
		// (publish) offer throws sfu_renegotiate_failed → media close + room
		// socket reconnect. Defer until the publish exchange has settled, and
		// debounce bursts of subscribe/track events into one offer.
		if (this.pullTimer !== null) window.clearTimeout(this.pullTimer);
		this.pullTimer = window.setTimeout(() => {
			this.pullTimer = null;
			void this.doNegotiatePull(connectionId);
		}, 250);
	}

	private async doNegotiatePull(connectionId: string) {
		if (this.publishInFlight) {
			this.pendingOffer = true;
			return;
		}
		// receive-only clients (no camera / witness seat) never publish — the
		// shared pc must still exist or their subscribes silently drop and
		// remote video never reaches them
		this.ensurePc();
		if (this.negotiating) {
			this.pendingOffer = true;
			return;
		}
		this.negotiating = true;
		try {
			const pc = this.pc;
			if (!pc) return;
			for (const [sessionId] of this.wanted) {
				const track = this.trackFor(sessionId);
				if (!track) continue;
				const sender = this.senderBySession.get(sessionId);
				if (sender) {
					if (sender.track !== track) await sender.replaceTrack(track).catch(() => {});
				} else {
					// addTransceiver, never addTrack: addTrack would reuse prod's
					// publish transceivers (recvonly + no sender track = a valid
					// reuse target), leaving the pull sender bound to an m-line
					// whose negotiated direction stays recvonly — zero RTP, and
					// prod's seat renders a permanently muted track. Pulls need
					// their own sendonly m-lines for prod to bind receivers to.
					this.senderBySession.set(
						sessionId,
						pc.addTransceiver(track, {
							direction: 'sendonly',
							streams: [this.session!.remoteStreams[sessionId.split(':')[0]] ?? new MediaStream()]
						}).sender
					);
				}
			}
			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);
			await iceGathered(pc);
			const pulls = pc
				.getTransceivers()
				.filter((tr) => tr.sender.track && this.wanted.has(this.sessionIdForTrack(tr.sender.track)))
				.map((tr) => {
					const sessionId = this.sessionIdForTrack(tr.sender.track!);
					this.pullMidSession.set(tr.mid ?? '', sessionId);
					return { mid: tr.mid ?? '', ownerId: sessionId.split(':')[0], kind: tr.sender.track!.kind, sessionId };
				});
			this.bridge.frame({ t: 'sfu-offer', sdp: pc.localDescription?.sdp ?? offer.sdp, pulls, connectionId });
		} catch (e) {
			console.debug('[sfu] pull negotiate failed', e);
		} finally {
			this.negotiating = false;
		}
	}

	private sessionIdForTrack(track: MediaStreamTrack): string {
		const shaped = this.shapedTrackSession.get(track);
		if (shaped) return shaped;
		const s = this.session;
		if (!s) return `:${track.kind}`;
		for (const [peerId, stream] of Object.entries(s.remoteStreams))
			if (stream.getTracks().includes(track)) return `${peerId}:${track.kind}`;
		return `:${track.kind}`;
	}

	/** temporary diagnostics: pull-leg sender/track binding state */
	__debug() {
		return {
			wanted: [...this.wanted.keys()],
			senders: [...this.senderBySession.entries()].map(([sid, s]) => ({
				sid,
				track: s.track
					? `${s.track.kind}${s.track.muted ? ':m' : ''}/${s.track.readyState}/${s.track.id.slice(0, 6)}`
					: null,
				enc: s
					.getParameters()
					.encodings?.map((e) => `${e.active !== false ? 'on' : 'off'}:${e.maxBitrate ?? '-'}`)
					.join(',')
			})),
			mids: [...this.pullMidSession.entries()],
			pcTrans: this.pc
				?.getTransceivers()
				.map((t) => `${t.direction}→${t.currentDirection}/${t.receiver.track?.kind}/${t.mid}`)
		};
	}

	dispose() {
		if (this.pullTimer !== null) window.clearTimeout(this.pullTimer);
		this.pullTimer = null;
		this.pc?.close();
		this.pc = null;
		this.wanted.clear();
		this.sentSessionIds.clear();
		this.senderBySession.clear();
	}
}

async function iceGathered(pc: RTCPeerConnection): Promise<void> {
	if (pc.iceGatheringState === 'complete') return;
	await new Promise<void>((resolve) => {
		const check = () => {
			if (pc.iceGatheringState === 'complete') {
				pc.removeEventListener('icegatheringstatechange', check);
				resolve();
			}
		};
		pc.addEventListener('icegatheringstatechange', check);
		setTimeout(() => {
			pc.removeEventListener('icegatheringstatechange', check);
			resolve();
		}, 1500);
	});
}
