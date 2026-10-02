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
}

/** extract m-line mids + kinds from an SDP blob (prod's publish offer) */
function parseMids(sdp: string): SdpSection[] {
	const out: SdpSection[] = [];
	let kind: SdpSection['kind'] | null = null;
	for (const line of sdp.split('\r\n')) {
		if (line.startsWith('m=audio')) kind = 'audio';
		else if (line.startsWith('m=video')) kind = 'video';
		else if (line.startsWith('a=mid:') && kind) out.push({ mid: line.slice(6), kind });
	}
	return out;
}

async function api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
	const res = await fetch(`${endpoint()}${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { 'content-type': 'application/json' },
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

	constructor(private bridge: BridgeLike) {}

	bind(session: RoomSession) {
		this.session = session;
	}

	private async ensureSession(): Promise<string> {
		if (this.sfuSessionId) return this.sfuSessionId;
		const res = await api<{ sessionId: string }>('/sessions/new', {});
		this.sfuSessionId = res.sessionId;
		// tell mesh peers where to pull our tracks from
		this.session?.announceSfu(res.sessionId);
		return res.sessionId;
	}

	publishReady(_connectionId: string, _requestId: string) {}

	async publish(sdpOffer: string, connectionId?: string, requestId?: string) {
		if (!sdpOffer) return;
		this.connectionId = connectionId ?? this.connectionId;
		try {
			const sid = await this.ensureSession();
			const tracks = parseMids(sdpOffer).map((s, i) => ({
				location: 'local',
				mid: s.mid,
				trackName: s.kind === 'audio' ? 'audio' : i === 1 ? 'video' : `video-${i}`
			}));
			const res = await api<{ sessionDescription?: { sdp: string } }>(
				`/sessions/${sid}/tracks/new`,
				{ sessionDescription: { type: 'offer', sdp: sdpOffer }, tracks }
			);
			this.bridge.frame({
				t: 'sfu-answer',
				sdp: res.sessionDescription?.sdp ?? '',
				connectionId,
				requestId
			});
		} catch (e) {
			console.debug('[cloud-sfu] publish failed', e);
		}
	}

	async subscribe(
		tracks: { sessionId: string; trackName?: string; kind?: string }[],
		connectionId: string
	) {
		try {
			const sid = await this.ensureSession();
			const remote = [];
			for (const t of tracks) {
				const peerId = t.sessionId.split(':')[0];
				const kind = t.kind ?? t.sessionId.split(':')[1] ?? 'audio';
				const peerSfu = this.session?.peerSfuSessions[peerId];
				if (!peerSfu) {
					// peer hasn't announced an SFU session (mesh-only or older
					// client) — remember the want; announced late via notifyStreams
					this.pendingPulls.push({ sessionId: t.sessionId, kind, trackName: t.trackName ?? kind });
					continue;
				}
				remote.push({ location: 'remote', sessionId: peerSfu, trackName: t.trackName ?? kind });
			}
			if (!remote.length) return;
			const res = await api<{ sessionDescription?: { type: string; sdp: string } }>(
				`/sessions/${sid}/tracks/new`,
				{ tracks: remote }
			);
			if (res.sessionDescription?.sdp) {
				this.bridge.frame({
					t: 'sfu-offer',
					sdp: res.sessionDescription.sdp,
					pulls: tracks.map((t) => ({
						sessionId: t.sessionId,
						ownerId: t.sessionId.split(':')[0],
						kind: t.kind ?? t.sessionId.split(':')[1] ?? 'audio'
					})),
					connectionId
				});
			}
		} catch (e) {
			console.debug('[cloud-sfu] subscribe failed', e);
		}
	}

	async answer(sdp: string, _connectionId: string) {
		if (!this.sfuSessionId) return;
		try {
			await api(`/sessions/${this.sfuSessionId}/renegotiate`, {
				sessionDescription: { type: 'answer', sdp }
			});
		} catch (e) {
			console.debug('[cloud-sfu] renegotiate failed', e);
		}
	}

	/** remote SFU sessions learned from peer hellos — announce new pull tracks */
	notifyStreams() {
		const s = this.session;
		if (!s) return;
		const fresh: { sessionId: string; trackName: string; kind: string; ownerId: string }[] = [];
		for (const [peerId, sfuSession] of Object.entries(s.peerSfuSessions)) {
			if (!sfuSession) continue;
			for (const kind of ['audio', 'video']) {
				const sessionId = `${peerId}:${kind}`;
				if (!this.announced.has(sessionId)) {
					this.announced.add(sessionId);
					fresh.push({ sessionId, trackName: kind, kind, ownerId: peerId });
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
	}
}
