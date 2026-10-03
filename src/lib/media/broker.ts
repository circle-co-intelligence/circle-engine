/**
 * broker.ts — beyond-GCC media coordination. libwebrtc's congestion control
 * optimizes ONE flow blind to the room; three moves it structurally can't do:
 *
 *   1. Room-level bandwidth broker — the elected 'bw-allocator' role collects
 *      per-peer link stats (bw-stats realtime frames), computes a fair-share
 *      sender budget from the worst reported uplink estimate, and broadcasts
 *      bw-budget — SFU-style cross-flow allocation, done peer-cooperatively.
 *   2. Predictive pre-emption — GCC reacts after loss; we watch the RTT
 *      gradient and bump the local pressure level before packets die.
 *   3. Path re-selection — a persistently failed pc gets restartIce() —
 *      GCC tunes bitrate, it can't reroute paths.
 */
import type { RoomHandle } from '../net/room';
import { applyPullHint } from './simulcast';

const SAMPLE_MS = 2000;
const RTT_WINDOW = 5;
const RESTART_AFTER_MS = 4000;

export class BwBroker {
	private timer = 0;
	private rttHist: number[] = [];
	private lastStats = new Map<RTCPeerConnection, { rtt: number; bytes: number; at: number }>();
	/** allocator-side view: peerId → its reported uplink estimate */
	private reports = new Map<string, number>();
	private failedSince = new Map<RTCPeerConnection, number>();
	private selfLimit: number | null = null;
	private destroyed = false;

	constructor(
		private room: RoomHandle,
		private selfId: string,
		/** true while this peer holds the elected bw-allocator role */
		private isAllocator: () => boolean,
		/** local pressure bump — session wires this to its adapt path */
		private onPreempt: () => void
	) {}

	start() {
		this.timer = window.setInterval(() => void this.tick(), SAMPLE_MS);
	}

	/** incoming broker frames — call from the session's realtime dispatch */
	handle(msg: { t: string; rttMs?: number; estKbps?: number; limit?: number }, peerId: string) {
		if (msg.t === 'bw-stats' && this.isAllocator() && msg.estKbps !== undefined) {
			this.reports.set(peerId, msg.estKbps);
			this.allocate();
		} else if (msg.t === 'bw-budget' && msg.limit !== undefined) {
			this.selfLimit = msg.limit;
			this.applyLimit();
		}
	}

	private async tick() {
		if (this.destroyed) return;
		const pcs = Object.values(this.room.raw.getPeers());
		let worstRtt = 0;
		for (const pc of pcs) {
			const rtt = await this.samplePc(pc);
			if (rtt > worstRtt) worstRtt = rtt;
			// path re-selection: a pc failed past the grace window gets
			// restartIce — GCC can't reroute, we can
			const st = pc.connectionState;
			if (st === 'failed' || st === 'disconnected') {
				const since = this.failedSince.get(pc) ?? Date.now();
				this.failedSince.set(pc, since);
				if (Date.now() - since > RESTART_AFTER_MS) {
					pc.restartIce();
					this.failedSince.delete(pc);
				}
			} else this.failedSince.delete(pc);
		}
		// predictive pre-emption: RTT gradient rising = congestion forming
		// before loss — bump pressure ahead of GCC's loss detection
		if (worstRtt > 0) {
			this.rttHist.push(worstRtt);
			if (this.rttHist.length > RTT_WINDOW) this.rttHist.shift();
			if (this.rttHist.length === RTT_WINDOW) {
				const first = this.rttHist[0];
				const last = this.rttHist[RTT_WINDOW - 1];
				if (last > first * 1.5 && last - first > 50) this.onPreempt();
			}
		}
		// report our own uplink estimate to the allocator
		const est = await this.selfEstimate(pcs);
		const allocatorId = this.allocatorPeerId();
		if (est !== null && allocatorId && allocatorId !== this.selfId)
			this.room.sendRealtime({ t: 'bw-stats', rttMs: worstRtt, estKbps: est }, allocatorId);
	}

	private allocatorPeerId(): string | null {
		// the session tracks role-holder changes and pushes them via setRoleHolder
		return this.roleHolder;
	}
	private roleHolder: string | null = null;
	setRoleHolder(peerId: string | null) {
		this.roleHolder = peerId;
	}

	/** min RTT across pc candidate-pairs, from getStats */
	private async samplePc(pc: RTCPeerConnection): Promise<number> {
		try {
			const stats = await pc.getStats();
			let rtt = 0;
			stats.forEach((s) => {
				if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime)
					rtt = Math.max(rtt, s.currentRoundTripTime * 1000);
			});
			return rtt;
		} catch {
			return 0;
		}
	}

	/** our worst-case uplink estimate across pcs (availableOutgoingBitrate) */
	private async selfEstimate(pcs: RTCPeerConnection[]): Promise<number | null> {
		let est: number | null = null;
		for (const pc of pcs) {
			try {
				const stats = await pc.getStats();
				stats.forEach((s) => {
					if (s.type === 'candidate-pair' && s.nominated && s.availableOutgoingBitrate)
						est = est === null ? s.availableOutgoingBitrate : Math.min(est, s.availableOutgoingBitrate);
				});
			} catch { /* pc mid-teardown */ }
		}
		return est === null ? null : Math.round(est / 1000);
	}

	/**
	 * Fair-share: the tightest reported uplink is the bottleneck estimate;
	 * every sender gets an equal slice (video leaves audio headroom — the
	 * audio share is already priority-steered in tune.ts).
	 */
	private allocate() {
		const senders = Math.max(1, Object.keys(this.room.raw.getPeers()).length + 1);
		let bottleneck = Infinity;
		for (const v of this.reports.values()) bottleneck = Math.min(bottleneck, v);
		if (!isFinite(bottleneck)) return;
		const per = Math.max(150, Math.floor(bottleneck / senders)); // ≥150kbps floor
		this.room.sendRealtime({ t: 'bw-budget', limit: per });
		this.selfLimit = per;
		this.applyLimit();
	}

	/**
	 * Clamp our video senders to the room budget. Simulcast-capable senders
	 * deactivate spatial layers first (q floor → h → f); single-encoding
	 * senders get a plain maxBitrate clamp — same budget either way.
	 */
	private applyLimit() {
		if (this.selfLimit === null) return;
		for (const pc of Object.values(this.room.raw.getPeers()))
			applyPullHint(pc, this.selfLimit);
	}

	dispose() {
		this.destroyed = true;
		window.clearInterval(this.timer);
		this.failedSince.clear();
		this.lastStats.clear();
		this.reports.clear();
	}
}
