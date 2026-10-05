/**
 * CloudSfu — Cloudflare Realtime (Calls) adapter. Implements the same frame
 * contract the prod frontend already speaks with SfuLoopback (publish →
 * sfu-answer, subscribe → sfu-offer, renegotiate-answer), but the far end is
 * Cloudflare's anycast SFU over its HTTPS signaling API:
 *
 *   publish(offer)  → POST sessions/new + tracks/new(local)  → sfu-answer
 *   subscribe(...)  → POST tracks/new(remote)                → sfu-offer
 *   answer(sdp)     → POST sessions/{id}/renegotiate
 *
 * SFrame E2EE is unaffected — the SFU forwards ciphertext. Remote peers find
 * each other's SFU sessions via the `sfu` field on the hello realtime frame.
 *
 * Endpoint: VITE_CIC_SFU_ENDPOINT (default '/api/sfu') — a Pages Function /
 * Worker proxy holding the app credentials; the client never sees them.
 */
import type { RoomSession } from '../state/room.svelte';
import { localAccount } from './account';

type Frame = Record<string, unknown>;
interface BridgeLike {
	frame(f: Frame): void;
	readonly isOpen: boolean;
}

const endpoint = (): string =>
	(import.meta.env as Record<string, string | undefined>).VITE_CIC_SFU_ENDPOINT ?? '/api/sfu';

interface SdpSection {
	mid: string;
	kind: 'audio' | 'video';
	/** direction attribute of the m-section (default sendrecv) */
	dir: 'sendonly' | 'recvonly' | 'sendrecv' | 'inactive';
}

/** extract m-line mids + kinds + direction from an SDP blob */
function parseMids(sdp: string): SdpSection[] {
	const out: SdpSection[] = [];
	let cur: SdpSection | null = null;
	for (const line of sdp.split('\r\n')) {
		if (line.startsWith('m=audio')) {
			cur = { mid: '', kind: 'audio', dir: 'sendrecv' };
		} else if (line.startsWith('m=video')) {
			cur = { mid: '', kind: 'video', dir: 'sendrecv' };
		} else if (cur) {
			if (line.startsWith('a=mid:')) {
				cur.mid = line.slice(6);
				out.push(cur);
			} else if (/^a=(sendonly|sendrecv|recvonly|inactive)$/.test(line)) {
				cur.dir = line.slice(2) as SdpSection['dir'];
			}
		}
	}
	return out;
}

async function api<T = Record<string, unknown>>(
	path: string,
	body?: unknown,
	method?: string,
	auth?: { room?: string; account?: string }
): Promise<T> {
	const res = await fetch(`${endpoint()}${path}`, {
		method: method ?? (body === undefined ? 'GET' : 'POST'),
		headers: {
			'content-type': 'application/json',
			...(auth?.room ? { 'x-cic-room': auth.room } : {}),
			...(auth?.account ? { 'x-cic-account': auth.account } : {})
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`sfu ${path} → ${res.status}`);
	return (await res.json()) as T;
}

export class CloudSfu {
	private session: RoomSession | null = null;
	private sfuSessionId: string | null = null;
	private connectionId = '';
	private pendingPulls: { sessionId: string; kind: string; trackName: string }[] = [];
	/** prod sessionId → last applied bandwidth clamp (tracks/update dedupe) */
	private pullClamps = new Map<string, number>();
	// one SFU session = one offer/answer state machine: CF rejects concurrent
	// mutations on the same session (406), so every tracks/new + renegotiate
	// runs through this queue
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private bridge: BridgeLike) {}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const p = this.queue.then(fn, fn); // run even if the prior op failed
		this.queue = p.catch(() => {});
		return p;
	}

	bind(session: RoomSession) {
		this.session = session;
	}

	publishReady(_connectionId: string, _requestId: string) {}

	async publish(sdpOffer: string, connectionId?: string, requestId?: string) {
		if (!sdpOffer) return;
		this.connectionId = connectionId ?? this.connectionId;
		await this.enqueue(() => this.doPublish(sdpOffer, connectionId, requestId));
	}

	/** mid → trackName of publications the SFU has accepted */
	private published = new Map<string, string>();
	private nameCounts: Record<'audio' | 'video', number> = { audio: 0, video: 0 };

	private trackName(kind: 'audio' | 'video'): string {
		const n = this.nameCounts[kind]++;
		return n === 0 ? kind : `${kind}-${n}`;
	}

	private async doPublish(sdpOffer: string, connectionId?: string, requestId?: string) {
		try {
			// CF recipe: sessions/new creates the session (no body); the publish
			// itself is tracks/new carrying the offer + local track defs.
			// Only send-capable m-sections are ours to publish — a re-offer
			// also describes the recvonly sections SFU pulls created, and
			// those must not be (re)registered as local publications.
			if (!this.sfuSessionId) {
				const created = await api<{ sessionId: string }>('/sessions/new', undefined, 'POST', {
					room: this.session?.roomCode,
					account: localAccount()?.accountId
				});
				this.sfuSessionId = created.sessionId;
			}
			const fresh = parseMids(sdpOffer).filter(
				(s) => s.mid && s.dir !== 'recvonly' && s.dir !== 'inactive' && !this.published.has(s.mid)
			);
			const tracks = fresh.map((s) => ({
				location: 'local',
				mid: s.mid,
				trackName: this.trackName(s.kind)
			}));
			const res = await api<{
				sessionId?: string;
				sessionDescription?: { sdp: string };
				tracks?: { mid?: string; trackName?: string; errorCode?: string }[];
			}>(`/sessions/${this.sfuSessionId}/tracks/new`, {
				sessionDescription: { type: 'offer', sdp: sdpOffer },
				tracks
			});
			// remember only the binds that succeeded
			const okNames = new Set(
				(res.tracks ?? []).filter((t) => !t.errorCode).map((t) => t.trackName)
			);
			for (const t of tracks)
				if (!res.tracks || okNames.has(t.trackName)) this.published.set(t.mid, t.trackName);
			if (this.sfuSessionId)
				this.session?.announceSfu(this.sfuSessionId, [...this.published.values()]);
			this.bridge.frame({
				t: 'sfu-answer',
				sdp: res.sessionDescription?.sdp ?? '',
				connectionId,
				requestId
			});
			// subscribes that predated our session can resolve now
			if (this.pendingPulls.length) {
				const pending = this.pendingPulls.splice(0);
				void this.subscribe(
					pending.map((p) => ({ sessionId: p.sessionId, kind: p.kind, trackName: p.trackName })),
					this.connectionId
				);
			}
		} catch (e) {
			console.debug('[cloud-sfu] publish failed', e);
		}
	}

	async subscribe(
		tracks: { sessionId: string; trackName?: string; kind?: string }[],
		connectionId: string
	) {
		await this.enqueue(() => this.doSubscribe(tracks, connectionId));
	}

	private async doSubscribe(
		tracks: { sessionId: string; trackName?: string; kind?: string }[],
		connectionId: string
	) {
		try {
			const trackNameOf = (t: { sessionId: string; trackName?: string; kind?: string }) =>
				t.trackName ?? t.sessionId.split(':').slice(1).join(':') ?? t.kind ?? 'audio';
			if (!this.sfuSessionId) {
				if (this.session?.witnessOnly) {
					// audience lane: receive-only — create the session for pulls
					// without ever publishing (quadratic→linear egress at scale)
					const created = await api<{ sessionId: string }>('/sessions/new', undefined, 'POST', {
						room: this.session?.roomCode,
						account: localAccount()?.accountId
					});
					this.sfuSessionId = created.sessionId;
				} else {
					// no Calls session until our first publish — stash the want
					this.pendingPulls.push(...tracks.map((t) => ({
						sessionId: t.sessionId,
						kind: t.kind ?? trackNameOf(t).split('-')[0],
						trackName: trackNameOf(t)
					})));
					return;
				}
			}
			const sid = this.sfuSessionId;
			const remote = [];
			for (const t of tracks) {
				const peerId = t.sessionId.split(':')[0];
				const trackName = trackNameOf(t);
				const kind = t.kind ?? trackName.split('-')[0];
				const peerSfu = this.session?.peerSfuSessions[peerId];
				if (!peerSfu) {
					// peer hasn't announced an SFU session (mesh-only or older
					// client) — remember the want; announced late via notifyStreams
					this.pendingPulls.push({ sessionId: t.sessionId, kind, trackName });
					continue;
				}
				// rid forward-compat: if a future prod build requests a specific
				// simulcast layer, honor it via CF's preferredRid; today prod
				// sends none and SFU forwards the publisher's single encoding
				const def: Record<string, unknown> = { location: 'remote', sessionId: peerSfu, trackName };
				const rid = (t as { rid?: string }).rid ?? (t as { preferredRid?: string }).preferredRid;
				if (rid) def.preferredRid = rid;
				const clamp = this.pullClamps.get(t.sessionId);
				if (clamp) def.bandwidthLimiter = { maxBitrate: clamp };
				remote.push(def);
			}
			if (!remote.length) return;
			const res = await api<{
				requiresImmediateRenegotiation?: boolean;
				sessionDescription?: { type: string; sdp: string };
				tracks?: { sessionId: string; trackName: string; mid?: string; errorCode?: string }[];
			}>(`/sessions/${sid}/tracks/new`, { tracks: remote });
			// CF requires the publication to be live before a pull binds —
			// not_found means the publisher's session exists but its tracks
			// aren't flowing yet; back off and retry (bounded)
			const notFound = new Set(
				(res.tracks ?? [])
					.filter((t) => t.errorCode === 'not_found_track_error')
					.map((t) => `${t.sessionId}:${t.trackName}`)
			);
			if (notFound.size) {
				const retry = tracks.filter((t) => {
					const peerId = t.sessionId.split(':')[0];
					const peerSfu = this.session?.peerSfuSessions[peerId];
					const tn = trackNameOf(t);
					return peerSfu && notFound.has(`${peerSfu}:${tn}`);
				});
				for (const t of retry) {
					const tries = (this.pullTries.get(t.sessionId) ?? 0) + 1;
					this.pullTries.set(t.sessionId, tries);
					if (tries > 12) continue; // ~20s of retries — give up, peer may have unpub'd
					this.pendingPulls.push({
						sessionId: t.sessionId,
						kind: t.kind ?? trackNameOf(t).split('-')[0],
						trackName: trackNameOf(t)
					});
				}
				if (this.pendingPulls.length) this.scheduleRetry();
			}
			// successful binds reset the backoff for that prod sessionId —
			// CF results carry the remote's sfu sessionId + trackName, map back
			for (const t of res.tracks ?? [])
				if (!t.errorCode) {
					const peerEntry = Object.entries(this.session?.peerSfuSessions ?? {}).find(
						([, v]) => v === t.sessionId
					);
					if (peerEntry) this.pullTries.delete(`${peerEntry[0]}:${t.trackName}`);
				}
			// remember each bound pull's receiving mid — tracks/update (clamps)
			// reuses transceivers and REQUIRES the mid; without it CF 406s
			for (const t of res.tracks ?? [])
				if (!t.errorCode && t.mid) this.boundPulls.set(`${t.sessionId}:${t.trackName}`, t.mid);
			if (res.sessionDescription?.sdp) {
				// CF returns the receiving mid per bound remote track — prod maps
				// ontrack transceivers to seats by mid, exactly like the loopback's
				// pullMidSession entries, so the mid must ride along in pulls
				const midFor = new Map<string, string>(
					(res.tracks ?? [])
						.filter((t) => t.mid && !t.errorCode)
						.map((t) => {
							const peerEntry = Object.entries(this.session?.peerSfuSessions ?? {}).find(
								([, v]) => v === t.sessionId
							);
							return [`${peerEntry?.[0] ?? ''}:${t.trackName}`, t.mid!] as const;
						})
				);
				this.bridge.frame({
					t: 'sfu-offer',
					sdp: res.sessionDescription.sdp,
					pulls: tracks.map((t) => ({
						sessionId: t.sessionId,
						mid: midFor.get(t.sessionId) ?? '',
						ownerId: t.sessionId.split(':')[0],
						kind: t.kind ?? trackNameOf(t).split('-')[0]
					})),
					connectionId
				});
			}
		} catch (e) {
			console.debug('[cloud-sfu] subscribe failed', e);
		}
	}

	private pullTries = new Map<string, number>(); // prod sessionId → attempts
	/** remote `${sessionId}:${trackName}` → bound receiving mid */
	private boundPulls = new Map<string, string>();
	private retryTimer: number | null = null;
	private scheduleRetry() {
		if (this.retryTimer !== null) return;
		this.retryTimer = window.setTimeout(() => {
			this.retryTimer = null;
			const pending = this.pendingPulls.splice(0);
			if (pending.length)
				void this.subscribe(
					pending.map((p) => ({ sessionId: p.sessionId, kind: p.kind, trackName: p.trackName })),
					this.connectionId
				);
		}, 1500);
	}

	/**
	 * Pull-side bandwidth clamp — CF's `tracks/update` applies a
	 * bandwidthLimiter to bound remote pulls without renegotiation. Called by
	 * the session's adaptive-media path: under pressure we clamp remote pulls
	 * instead of the (prod-owned, untouchable) send encodings.
	 */
	async clampPulls(maxBitrate: number | null) {
		const sid = this.sfuSessionId;
		if (!sid) return;
		const targets: Record<string, unknown>[] = [];
		for (const [peerId, peerSfu] of Object.entries(this.session?.peerSfuSessions ?? {})) {
			if (!peerSfu) continue;
			const names = this.session?.peerSfuTracks[peerId] ?? ['audio', 'video'];
			for (const trackName of names.filter((n) => n.split('-')[0] === 'video')) {
				const key = `${peerId}:${trackName}`;
				const mid = this.boundPulls.get(`${peerSfu}:${trackName}`);
				if (!mid) continue; // pull never bound — no transceiver to update
				if (maxBitrate === null) {
					if (!this.pullClamps.has(key)) continue; // nothing clamped — skip, don't spam
					this.pullClamps.delete(key);
				} else {
					if (this.pullClamps.get(key) === maxBitrate) continue;
					this.pullClamps.set(key, maxBitrate);
				}
				targets.push({
					location: 'remote',
					sessionId: peerSfu,
					trackName,
					mid,
					...(maxBitrate === null ? {} : { bandwidthLimiter: { maxBitrate } })
				});
			}
		}
		if (!targets.length) return;
		await this.enqueue(async () => {
			try {
				await api(`/sessions/${sid}/tracks/update`, { tracks: targets }, 'PUT');
			} catch (e) {
				console.debug('[cloud-sfu] tracks/update failed', e);
			}
		});
	}

	/** per-peer pull clamp — e.g. away peers drop video to a trickle */
	async clampPeerPulls(peerId: string, maxBitrate: number | null) {
		const sid = this.sfuSessionId;
		const peerSfu = this.session?.peerSfuSessions?.[peerId];
		if (!sid || !peerSfu) return;
		const names = this.session?.peerSfuTracks[peerId] ?? ['audio', 'video'];
		const targets = names
			.filter((n) => n.split('-')[0] === 'video')
			.map((trackName) => ({
				location: 'remote',
				sessionId: peerSfu,
				trackName,
				...(maxBitrate === null ? {} : { bandwidthLimiter: { maxBitrate } })
			}));
		if (!targets.length) return;
		await this.enqueue(async () => {
			try {
				await api(`/sessions/${sid}/tracks/update`, { tracks: targets }, 'PUT');
			} catch {}
		});
	}

	async answer(sdp: string, _connectionId: string) {
		await this.enqueue(async () => {
			if (!this.sfuSessionId) return;
			// CF Realtime accepts the endpoint's answer via PUT /renegotiate
			try {
				await api(
					`/sessions/${this.sfuSessionId}/renegotiate`,
					{ sessionDescription: { type: 'answer', sdp } },
					'PUT'
				);
			} catch (e) {
				console.debug('[cloud-sfu] renegotiate failed', e);
			}
		});
	}

	/** remote SFU sessions learned from peer hellos — announce new pull tracks */
	notifyStreams() {
		const s = this.session;
		if (!s) return;
		const fresh: { sessionId: string; trackName: string; kind: string; ownerId: string }[] = [];
		for (const [peerId, sfuSession] of Object.entries(s.peerSfuSessions)) {
			if (!sfuSession) continue;
			// real publication names when the peer announced them; legacy
			// string-only announcements fall back to the audio/video convention
			const names = s.peerSfuTracks[peerId] ?? ['audio', 'video'];
			for (const name of names) {
				const sessionId = `${peerId}:${name}`;
				if (!this.announced.has(sessionId)) {
					this.announced.add(sessionId);
					fresh.push({ sessionId, trackName: name, kind: name.split('-')[0], ownerId: peerId });
				}
			}
		}
		if (fresh.length) this.bridge.frame({ t: 'sfu-pull', tracks: fresh });
		// retry pulls that predated the peer's SFU announcement
		const nowKnown = this.pendingPulls.filter(
			(p) => s.peerSfuSessions[p.sessionId.split(':')[0]]
		);
		if (nowKnown.length) {
			this.pendingPulls = this.pendingPulls.filter((p) => !nowKnown.includes(p));
			void this.subscribe(nowKnown.map((p) => ({ sessionId: p.sessionId, kind: p.kind, trackName: p.trackName })), this.connectionId);
		}
	}

	private announced = new Set<string>();

	dispose() {
		this.session = null;
		this.pendingPulls = [];
		this.pullTries.clear();
		this.announced.clear();
		this.published.clear();
		this.nameCounts = { audio: 0, video: 0 };
		if (this.retryTimer !== null) {
			window.clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
	}
}
