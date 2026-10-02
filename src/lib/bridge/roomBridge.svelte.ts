/**
 * RoomBridge — terminates the production CIC wire protocol in-process.
 * The vendored production frontend opens a WebSocket to /ws/room/{code};
 * this class answers it with real welcome/snapshot/delta/chat/caption
 * frames driven by the actual RoomSession engine (Trystero mesh + signed
 * op-log + XState stick + RoomRatchet E2EE).
 *
 * Every client→server command is executed against real session state —
 * nothing is acknowledged without taking effect.
 */
import { untrack } from 'svelte';
import { LocalSocket } from './localSocket';
import { RoomSession } from '../state/room.svelte';
import { roomSecretFromCode } from '../net/room';
import { SfuLoopback } from './sfu';
import { SpeechStreamPipe, TranslationFanout, TranslationSpeechPipe } from './stt';
import { SpeakingMonitor } from './speaking';
import { translateText } from '../ai/translate';
import { budget as creditsBudget, quote as creditsQuote, confirm as creditsConfirm, balance as creditsBalance } from '../ledger/credits';
import { startLink, pollLink, sessionToken } from './account';
import { artifactsFor, noteArtifact, type Artifact } from './artifacts';
import type { Op } from '../wire/messages';

type Frame = Record<string, unknown>;

type ProdParticipant = {
	id: string;
	name: string;
	kind?: 'ai' | 'human';
	joinedAt: number;
	connected: boolean;
	away?: boolean;
	muted: { audio: boolean; video: boolean };
	tracks: { sessionId: string; kind: string }[];
	handRaisedAt?: number;
	sharing?: string;
	role?: string;
};

type SessionEntry = { session: RoomSession; leaveTimer: number };

// prod reconnects the room socket on resync, breakout moves and media-plane
// restarts — the mesh session outlives individual sockets so peers see no
// leave/join churn. The entry carries a deferred-leave timer: a hello within
// the grace window adopts the session; otherwise it really leaves.
const REJOIN_GRACE_MS = 20_000;
let sessionByCode = new Map<string, SessionEntry>();

// prod's socket reconnects create a fresh bridge but keep the mesh session —
// request/response and one-shot event state must survive that or frames like
// recording-ready (prod waits on it ≤15s, then self-aborts) are lost forever
const pendingRecordReqs = new Map<string, string>(); // code:meshPeerId → requestId
const pendingFrames = new Map<string, Frame[]>(); // code:meshPeerId → events dropped while socket was down

/**
 * Targeted-send registry — room code → mesh peerId → bridge. Targeted frames
 * (admitted, removed, force-muted, caption-audio fanout) address a specific
 * participant's socket, which lives inside that participant's own bridge.
 * prodId↔peerId note: remote participants are framed by mesh peerId; only
 * self carries a prod-declared id, so the registry keys on session.selfId.
 */
const bridgesByPeer = new Map<string, Map<string, RoomBridge>>();

/** sessionTokens issued in welcome frames — a valid token is a resync credential */
const issuedTokens = new Map<string, Set<string>>();

function sendToPeer(code: string, peerId: string, frame: Frame) {
	bridgesByPeer.get(code)?.get(peerId)?.frame(frame);
}

export class RoomSocket extends LocalSocket {
	private bridge: RoomBridge;

	constructor(url: string, roomKey?: string) {
		super(url);
		const code = decodeURIComponent(url.split('/ws/room/')[1]?.split('?')[0] ?? '');
		this.bridge = new RoomBridge(this, code, roomKey);
		this.open();
	}

	/** frame delivery back to the frontend — used by the bridge */
	emitNow(f: Frame) {
		this.emit(JSON.stringify(f));
	}
	emitter() {
		return { frame: (f: Frame) => this.bridge.frame(f) }; // route through the logged path
	}
	get session(): RoomSession | null {
		return this.bridge.sessionRef;
	}
	get selfId(): string {
		return this.bridge.selfProdIdRef;
	}
	get captionRate(): number {
		return this.bridge.captionSampleRateRef;
	}
	get captionSub(): number {
		return this.bridge.captionSubscriptionRef;
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
		if (typeof data !== 'string') return; // binary frames belong to the caption socket
		if (data === 'ping') return this.emit('pong');
		let msg: Frame;
		try {
			msg = JSON.parse(data);
		} catch {
			return;
		}
		if (this.bridge.isRetired) return; // stale socket — session moved to a newer bridge
		if (msg.t !== 'speech-frame')
			console.debug('[cic-ws →]', msg.t, msg.t === 'caption-subscribe' || msg.t === 'caption-source-ready' || msg.t === 'speech-open' || msg.t === 'metric' ? JSON.stringify(msg) : '');
		this.bridge.command(msg);
	}

	protected onClose() {
		void this.bridge.leave();
	}
}

class RoomBridge {
	private sock: RoomSocket;
	private session: RoomSession | null = null;
	private seq = 0;
	private selfProdId = '';
	private name = '';
	private code: string;
	private sfu = new SfuLoopback(this);
	private sessionStartedAt = Date.now();
	private lastChatLen = 0;
	private lastCapLen = 0;
	private stopFx: (() => void) | null = null;
	private captionGen = 0;
	private captionSubscribed = false;
	private captionSubscription = 0;
	private captionSampleRate = 16000;
	private publishDone = false;
	private captionSourceSent = false;
	private captionFails = 0;
	private captionFailTimer: (() => void) | null = null;
	private seenCaptionSections = new Set<string>();
	private speechStreams = new Map<string, SpeechStreamPipe | TranslationSpeechPipe>();
	private explicitLeave = false;
	private speaking = new SpeakingMonitor((peerId) =>
		this.delta([{ op: 'speaking', id: peerId ? this.prodId(peerId) : null }])
	);
	private prevTracks = new Map<string, string>();
	private terminated = false;
	private retired = false;
	private fanout: TranslationFanout | null = null;
	private lastTrLen = 0;

	private trFanout(): TranslationFanout | null {
		if (this.session && !this.fanout)
			this.fanout = new TranslationFanout(this.session, this.sock.emitter());
		return this.fanout;
	}

	constructor(sock: RoomSocket, code: string, private roomKey?: string) {
		this.sock = sock;
		this.code = code;
	}

	get isOpen() {
		return this.sock.readyState === 1;
	}
	get isRetired() {
		return this.retired;
	}
	get sessionRef(): RoomSession | null {
		return this.session;
	}
	get selfProdIdRef(): string {
		return this.selfProdId;
	}
	get captionSampleRateRef(): number {
		return this.captionSampleRate;
	}
	get captionSubscriptionRef(): number {
		return this.captionSubscription;
	}

	private get pendingKey(): string {
		return `${this.code}:${this.session?.selfId ?? ''}`;
	}

	get pendingRecordReq(): string | null {
		return pendingRecordReqs.get(this.pendingKey) ?? null;
	}
	set pendingRecordReq(v: string | null) {
		if (v === null) pendingRecordReqs.delete(this.pendingKey);
		else pendingRecordReqs.set(this.pendingKey, v);
	}

	frame(f: Frame) {
		if (f.t !== 'chat' && f.t !== 'notes-state')
			console.debug('[cic-ws ←]', f.t, JSON.stringify(f).slice(0, JSON.stringify(f).includes('"ai"') ? 900 : 220));
		if (this.sock.readyState === 1) this.sock.emitNow(f);
		// delta/snapshot resync covers seq'd state; one-shot events emitted while
		// the socket was down queue here and drain on the client's next hello
		else if (f.t !== 'delta' && f.t !== 'snapshot') {
			const q = pendingFrames.get(this.pendingKey) ?? [];
			if (q.length < 32) q.push(f);
			pendingFrames.set(this.pendingKey, q);
		}
	}

	private delta(ops: Record<string, unknown>[]) {
		if (!ops.length) return;
		this.frame({ t: 'delta', ops, seq: ++this.seq });
	}

	private prodId(peerId: string): string {
		return peerId === this.session?.selfId ? this.selfProdId : peerId;
	}
	private peerId(prodId: string): string {
		return prodId === this.selfProdId ? (this.session?.selfId ?? prodId) : prodId;
	}

	private participantOf(peerId: string): ProdParticipant {
		const s = this.session!;
		const tracks: ProdParticipant['tracks'] = [];
		const muted = peerId === s.selfId
			? { audio: s.selfMuted, video: s.videoMuted }
			: (s.peerMuted[peerId] ?? { audio: false, video: false });
		if (s.remoteStreams[peerId] || peerId === s.selfId) {
			tracks.push({ sessionId: `${peerId}:audio`, kind: 'audio' });
			if (!muted.video) tracks.push({ sessionId: `${peerId}:video`, kind: 'video' });
			if (s.peerSharing.has(peerId)) tracks.push({ sessionId: `${peerId}:screen`, kind: 'screen' });
		}
		return {
			id: this.prodId(peerId),
			name: s.names[peerId] ?? (peerId === s.selfId ? this.name : 'Guest'),
			kind: 'human',
			joinedAt: s.joinedAt[peerId] ?? this.sessionStartedAt,
			connected: true,
			away: s.peerAway.has(peerId) || undefined,
			muted,
			tracks,
			handRaisedAt: s.raisedHands.has(peerId) ? Date.now() : undefined,
			sharing: s.peerSharing.has(peerId) ? 'screen' : undefined
		};
	}

	private stickObj() {
		const s = this.session!;
		const ctx = s.stickCtx;
		const state =
			s.stickState === 'held' ? 'held' : s.stickState === 'question' ? 'question' : s.stickState === 'offered' ? 'offered' : 'on_table';
		return {
			state,
			holderId: ctx.holderId ? this.prodId(ctx.holderId) : null,
			atSeatOf: ctx.atSeatOf ? this.prodId(ctx.atSeatOf) : null,
			resumeTo: ctx.resumeTo ? this.prodId(ctx.resumeTo) : null,
			since: null as number | null,
			handsOpen: s.mode === 'open_round' && state === 'on_table'
		};
	}

	private nextId(): string | null {
		const s = this.session!;
		const seated = [s.selfId, ...s.activePeers].sort(
			(a, b) => (s.joinedAt[a] ?? 0) - (s.joinedAt[b] ?? 0)
		);
		const cur = s.stickCtx.holderId ?? s.stickCtx.atSeatOf;
		if (seated.length < 2) return null;
		const order = s.direction === 'sunwise' ? seated : [...seated].reverse();
		const i = cur ? order.indexOf(cur) : -1;
		const next = order[(i + 1 + order.length) % order.length];
		return next ? this.prodId(next) : null;
	}

	private snapshot() {
		const s = this.session!;
		// lobby: while we wait (lobby-wait confirmed, not yet admitted) our own
		// snapshot seats us in `waiting` — prod renders its waiting-room state
		const selfWaiting = s.waitingSelf && !s.admitted;
		const participants = [s.selfId, ...s.activePeers]
			.filter((p) => !(p === s.selfId && selfWaiting) && !s.waiting.some((w) => w.id === p))
			.map((p) => this.participantOf(p))
			.sort((a, b) => a.joinedAt - b.joinedAt);
		if (s.ai.enabled !== false) {
			participants.push({
				id: 'ai',
				name: s.ai.name ?? 'Milo',
				kind: 'ai',
				joinedAt: this.sessionStartedAt - 1,
				connected: true,
				muted: { audio: false, video: true },
				tracks: []
			});
		}
		return {
			code: this.code,
			sessionId: `local-${this.code}`,
			participants,
			hostId: s.authorityId ? this.prodId(s.authorityId) : null,
			coHostIds: s.coHostIds.map((id) => this.prodId(id)),
			mode: s.mode,
			direction: s.direction,
			stick: this.stickObj(),
			nextId: this.nextId(),
			aiSpeaking: s.miloState === 'speaking',
			waiting: [
				...s.waiting.map((w) => ({
					id: w.id, name: w.name, joinedAt: w.joinedAt, connected: true, muted: { audio: true, video: true }, tracks: []
				})),
				...(selfWaiting
					? [{ id: this.selfProdId, name: this.name, joinedAt: this.sessionStartedAt, connected: true, muted: { audio: true, video: true }, tracks: [] }]
					: [])
			],
			lobbyEnabled: s.lobbyEnabled,
			// captions capability we actually provide: on-device sherpa streaming ASR;
			// 'deepgram' names their speech-stream protocol lane — we terminate it locally
			features: {
				stt: 'deepgram',
				captions: { provider: 'soniox', available: true, epoch: 'sherpa-local' }
			},
			credits: null,
			channel: s.breakoutChannels[s.selfId] ?? 0,
			breakouts: s.breakoutCount
				? {
					count: s.breakoutCount,
					allowReturn: s.breakoutAllowReturn,
					freeJoin: s.breakoutFreeJoin,
					// prod indexes breakouts.names[ch-1] without a guard — always an array
					names: s.breakoutNames,
					roster: [s.selfId, ...s.activePeers]
						.filter((p) => !s.waiting.some((w) => w.id === p))
						.map((p) => ({
							id: this.prodId(p),
							name: s.names[p] ?? (p === s.selfId ? this.name : 'Peer'),
							channel: s.breakoutChannels[p] ?? 0
						}))
				}
				: null,
			brand: null,
			breakoutDefaults: null,
			appearance: s.appearance,
			ai: s.ai,
			heartMode: s.heartMode,
			hostLocks: s.hostLocks,
			miloWake: s.miloWake,
			started: s.started,
			turnTimerMinutes: s.turnTimerMinutes,
			speakingTimerEveryone: s.speakingTimerEveryone,
			trFanout: s.trFanout,
			recording: s.recording,
			recordingSessions: this.recordingSessions(),
			chat: s.chatLog.map((c) => ({ from: this.prodId(c.from), name: s.names[c.from] ?? this.name, text: c.text, at: Date.now(), whisper: c.whisper })),
			transcript: [],
			feedbackPermit: true,
			dashboardUrl: null
		};
	}

	private recordingsItems(): Artifact[] {
		return artifactsFor(this.code);
	}

	private recordingSessions() {
		const s = this.session;
		// prod's consent dialog keys off recordingSessions — emit the pending
		// session too (recorderId present, consentedIds accruing) not just active
		if (!s || (!s.recording && !s.consentAsked && !s.recordingProposer)) return [];
		const recorderPeer = s.recordingProposer ?? s.authorityId ?? s.selfId;
		const recorderId = this.prodId(recorderPeer);
		const consented = Object.entries(s.consents)
			.filter(([, v]) => v === 'granted')
			.map(([k]) => this.prodId(k));
		const recorderName =
			recorderPeer === s.selfId ? s.names[s.selfId] ?? 'You' : s.names[recorderPeer] ?? 'Peer';
		return [{ recorderId, recorderName, consentedIds: [...consented], toServer: false, startedAt: this.sessionStartedAt }];
	}

	// ---------------------------------------------------------------- commands

	async command(m: Frame) {
		const s = this.session;
		try {
			await this.dispatch(m, s);
		} catch (e) {
			console.error('[cic-bridge] command failed', m.t, e);
			this.frame({ t: 'error', code: 'engine_error', message: String(e) });
		}
	}

	private async dispatch(m: Frame, s: RoomSession | null) {
		switch (m.t) {
			case 'hello': {
				this.selfProdId = String(m.participantId ?? crypto.randomUUID());
				this.name = String(m.name ?? 'Guest');
				const entry = sessionByCode.get(this.code);
				let created = false;
				if (!this.session && entry) {
					// prod reopened the socket (resync / breakout move / media
					// restart) — adopt the live mesh session, cancel its leave.
					// A retired bridge (stale client resyncing) only borrows the
					// session to answer welcome+snapshot — no watch/teardown
					// ownership, the live bridge keeps both.
					this.session = entry.session;
					if (!this.retired) {
						clearTimeout(entry.leaveTimer);
						this.sfu.bind(this.session);
						this.watch();
					}
				} else if (!this.session) {
					this.session = new RoomSession(roomSecretFromCode(this.code, this.roomKey), this.name, this.code);
					sessionByCode.set(this.code, { session: this.session, leaveTimer: 0 });
					this.sfu.bind(this.session);
					created = true;
					// proof hash travels in hello.cap[2] — members verify it against
					// the op-log passwordHash (we can't know it pre-sync ourselves)
					if (m.password) {
						const { sha256 } = await import('@noble/hashes/sha2.js');
						const { bytesToHex } = await import('@noble/hashes/utils.js');
						this.session.accessHash = bytesToHex(sha256(`${this.code}:${String(m.password)}`));
					}
					await this.session.join({ capture: false }); // frontend owns getUserMedia
					this.watch();
				}
				// fast local check when we already hold room state — a sessionToken
				// we issued on an earlier welcome IS the resync credential, so
				// members who set a password mid-room aren't locked out of their
				// own reconnects; mesh denial covers fresh joiners
				const resumed = !!m.sessionToken && issuedTokens.get(this.code)?.has(String(m.sessionToken));
				if (this.session && !resumed && !(await this.session.checkPassword(String(m.password ?? '')))) {
					console.debug('[cic-ws] denied: local check', { created, tok: !!m.sessionToken });
					this.frame({ t: 'error', code: 'password_required', message: 'This circle is password-protected.' });
					if (created) {
						sessionByCode.delete(this.code);
						void this.session.leave();
					}
					this.session = null;
					this.sock.close();
					return;
				}
				// registry for targeted frames (admitted / removed / force-muted /
				// caption-audio fanout) — keyed by this bridge's mesh peer id
				if (this.session && !this.retired) {
					let byPeer = bridgesByPeer.get(this.code);
					if (!byPeer) bridgesByPeer.set(this.code, (byPeer = new Map()));
					// one socket per participant — a remount/resync hello adopts the
					// same session; the stale bridge must stop emitting or its deltas
					// (own seq counter) race ours and prod resyncs forever. A retired
					// bridge never takes the slot back (stale-client resync would
					// flip-flop between two live sockets).
					const prev = byPeer.get(this.session.selfId);
					if (prev && prev !== this) prev.retire();
					byPeer.set(this.session.selfId, this);
				}
				// resync (prod's applyDelta miss → hello with resumeFrom) reuses
				// the same session — only the snapshot + seq are re-sent
				const token = sessionToken(this.code) ?? crypto.randomUUID();
				let tok = issuedTokens.get(this.code);
				if (!tok) issuedTokens.set(this.code, (tok = new Set()));
				tok.add(token);
				this.frame({
					t: 'welcome',
					sessionToken: token,
					you: this.selfProdId,
					seq: this.seq,
					iceServers: [],
					media: true,
					snapshot: this.snapshot()
				});
				this.frame({ t: 'snapshot', room: this.snapshot(), seq: this.seq });
				const items = this.recordingsItems();
				if (items.length) this.frame({ t: 'recordings', items });
				// event frames dropped while this peer's socket was down — flush
				// after welcome+snapshot so prod applies state before events
				const queued = pendingFrames.get(this.pendingKey);
				if (queued?.length) {
					pendingFrames.delete(this.pendingKey);
					for (const f of queued) this.frame(f);
				}
				break;
			}
			case 'leave': this.explicitLeave = true; this.sock.close(); break;
			// no TURN needed (local mesh) — but iceExpiresAt: 0 would leave prod's
			// refresh timer permanently overdue; answer with a real future expiry
			case 'refresh-ice':
				this.frame({ t: 'ice-servers', iceServers: [], iceExpiresAt: Date.now() + 3_600_000 });
				break;

			// stick
			case 'pass': s?.passStick(); break;
			case 'place-down': s?.tableStick(); break;
			case 'take-stick': s?.requestStick(); break; // prod's on-table "Take the stick" control
			case 'give-stick': s?.giveStick(this.peerId(String(m.id))); break;
			case 'host-set-current': m.id === 'table' ? s?.tableStick() : s?.giveStick(this.peerId(String(m.id))); break;
			case 'request-stick': case 'stick-request': s?.requestStick(); break;
			case 'question-end': s?.emitOp({ t: 'stick-resume' }); break;

			// room state ops
			case 'set-mode': {
				if (m.mode) s?.setMode(m.mode as 'open_round' | 'circle_round');
				if (m.direction) s?.setDirection(m.direction as 'sunwise' | 'earthwise');
				break;
			}
			case 'set-direction': s?.setDirection(m.direction as 'sunwise' | 'earthwise'); break;
			case 'set-heart': s?.setHeart(!!m.on); break;
			case 'set-lobby': s?.setLobby(!!m.enabled); break;
			case 'set-co-host': s?.setCoHost(this.peerId(String(m.id)), !!m.on); break;
			case 'set-host-lock': if (s) s.setHostLocks({ ...s.hostLocks, [String(m.feature)]: !!m.on }); break;
			case 'set-speaking-timer': s?.setSpeakingTimerEveryone(!!m.enabled); break;
			case 'turn-timer': s?.setTurnTimer(Number(m.minutes ?? 0)); break;
			case 'set-appearance': {
				const { t: _t, ...patch } = m;
				s?.setAppearance(patch as Record<string, string>);
				break;
			}
			case 'started': case 'set-started': s?.setStarted(!!m.on); break;

			// self state — a `target` field means host force-mute of that seat
			case 'mute':
				if (m.target && s) {
					// force-mute only ever closes — remote unmute is forbidden
					if (m.on === false) break;
					const kind = m.kind === 'video' ? 'video' : 'audio';
					s.forceMute(this.peerId(String(m.target)), kind, true);
					sendToPeer(this.code, this.peerId(String(m.target)), { t: 'force-muted', kind });
					break;
				}
				if (m.kind === 'video') s?.setVideoMuted(!!m.on);
				else s?.setSelfMuted(!!m.on);
				this.frame({ t: 'mute-state', muted: { audio: s?.selfMuted ?? true, video: s?.videoMuted ?? true } });
				break;
			case 'away': s?.announceAway(!!m.away); break;
			case 'screen': s?.announceSharing(!!m.on, m.audio === true || m.audio === 'audio'); break;
			case 'hand': s?.raiseHand(!!m.up); break;
			case 'set-name': s?.renameSelf(String(m.name ?? '')); break;
			case 'reaction': s?.react(String(m.kind ?? 'heart')); break;
			case 'chat': {
				const text = String(m.text ?? '');
				if (s && text) {
					s.sendChat(text);
					this.frame({ t: 'chat', entry: { id: crypto.randomUUID(), from: this.selfProdId, name: this.name, text, at: Date.now() } });
				}
				break;
			}
			case 'notes-save': s?.saveNotes(String(m.text ?? '')); break;

			// lobby / host controls
			case 'admit': {
				const pid = this.peerId(String(m.id));
				s?.admitWaiting(pid);
				// prod moves the waiter into seats on the `admit` op; the joiner's
				// own socket gets the targeted `admitted` frame (store.closed=null)
				this.delta([{ op: 'admit', id: String(m.id) }]);
				sendToPeer(this.code, pid, { t: 'admitted' });
				break;
			}
			case 'remove': {
				// prod uses `remove` for both host kick and lobby "Decline"
				const pid = this.peerId(String(m.id));
				if (!s) break;
				if (s.waiting.some((w) => w.id === pid)) s.declineWaiting(pid);
				else s.removePeer(pid);
				break;
			}
			case 'set-password': if (s) await s.setPassword(String(m.password ?? '')); break;
			case 'set-store-transcript': s?.setAi({ storeTranscript: !!m.on }); break;

			// ai
			case 'set-ai': s?.setAi({ enabled: !!m.enabled }); break;
			case 'set-ai-name': s?.setAi({ name: String(m.name) }); break;
			case 'set-ai-instructions': s?.setAi({ instructions: String(m.text) }); break;
			case 'set-ai-voice': s?.setAi({ voice: String(m.voice) }); break;
			case 'set-milo-standby': s?.setAi({ standby: !!m.on }); break;
			case 'set-milo-wake': s?.setMiloWake(m.mode === 'hey_milo' ? 'hey_milo' : 'click'); break;
			case 'ask-ai': s?.askAi(typeof m.text === 'string' ? m.text : undefined); break;
			case 'stop-ai': s?.stopMilo(); break; // "Anyone may rest or stop him"
			case 'set-transcription':
				s?.setTranscription(!!m.on);
				s?.setAi({ transcription: !!m.on }); // prod gates caption capture on ai.transcription
				break;
			case 'set-transcription-scope': s?.emitOp({ t: 'config-set', patch: { transcriptScope: String(m.scope) as 'off' | 'holder' | 'all' } }); break;

			// recording
			case 'recording': {
				if (m.action === 'start') {
					// prod waits on recording-ready{requestId} — the server's consent/
					// allowance confirmation. Ours fires only after real consent:
					// sessions emit while pending, peers consent, the op lands.
					if (m.requestId) this.pendingRecordReq = String(m.requestId);
					if (s && !s.heartMode) {
						s.startRecording();
						if (s.recording && this.pendingRecordReq) {
							this.frame({ t: 'recording-ready', requestId: this.pendingRecordReq });
							this.pendingRecordReq = null;
						}
					} else {
						this.pendingRecordReq = null;
						this.frame({ t: 'error', code: 'heart_mode', message: 'Heart-Sharing is on — recording is disabled in this circle.' });
					}
				} else if (m.action === 'stop') {
					this.pendingRecordReq = null;
					s?.stopRecording();
				}
				break;
			}
			case 'recording-consent': s?.answerConsent(true); break;
			case 'recording-budget':
				// prod's onRecordingBudget(requestId, budget, canPurchase) — real
				// Dexie ledger numbers; remainingSeconds null renders "Unlimited"
				// (local recording needs no budget); purchasedSeconds is the ledger
				this.frame({ t: 'recording-budget', requestId: m.requestId, ...(await creditsBudget(this.code)) });
				break;
			case 'recording-purchase': {
				// {requestId, action:'quote'|'confirm', blocks|quoteId} →
				// reply wraps the outcome: {requestId, result:{status,...}}
				let result: Record<string, unknown>;
				if (m.action === 'quote') {
					result = await creditsQuote(this.code, Number(m.blocks) || 1) as unknown as Record<string, unknown>;
				} else if (m.action === 'confirm') {
					const r = await creditsConfirm(this.code, String(m.quoteId ?? ''));
					result = r as unknown as Record<string, unknown>;
				} else {
					result = { status: 'unavailable' };
				}
				this.frame({ t: 'recording-purchase', requestId: m.requestId, result });
				if (result.status === 'purchased') {
					// prod's credits delta op — the ledger balance is the source
					const remaining = await creditsBalance(this.code);
					this.delta([{ op: 'credits', remaining, reference: Date.now(), lowWarned: false, sttMinutesLeft: null, sttLowWarned: false }]);
				}
				break;
			}
			case 'rec-upload-begin': {
				const key = `local-${crypto.randomUUID()}.${m.ext ?? 'webm'}`;
				this.frame({ t: 'rec-upload', key, url: `/rec-local/${key}`, method: 'PUT' });
				break;
			}
			case 'rec-uploaded': {
				// the artifact PUT already landed in the local store — surface it
				if (m.key) noteArtifact(this.code, String(m.key), Number(m.bytes) || 0);
				this.frame({ t: 'recordings', items: this.recordingsItems() });
				break;
			}

			// breakouts
			case 'breakout-open':
				s?.openBreakouts(Number(m.count ?? 2), {
					freeJoin: m.freeJoin === true,
					allowReturn: m.allowReturn !== false,
					names: Array.isArray(m.names) ? m.names.map(String) : undefined
				});
				break;
			case 'breakout-close': s?.closeBreakouts(); break;
			case 'breakout-assign': s?.assignBreakout(this.peerId(String(m.id)), String(m.channel ?? '0')); break;
			case 'breakout-hop': {
				const ch = Number(m.channel ?? 0);
				s?.hopBreakout(ch);
				this.frame({ t: 'breakout-move', channel: ch });
				if (s) void (ch > 0 ? s.joinBreakout(String(ch)) : s.returnFromBreakout());
				break;
			}
			case 'breakout-return':
				if (s) {
					void s.returnFromBreakout();
					this.frame({ t: 'breakout-move', channel: 0 });
				}
				break;
			case 'breakout-broadcast': s?.broadcastToBreakouts(String(m.message ?? '')); break;

			// SFU media plane → loopback
			case 'publish':
				void this.sfu.publish(String(m.offer ?? ''), m.connectionId ? String(m.connectionId) : undefined, m.requestId ? String(m.requestId) : undefined)
					.then(() => { this.publishDone = true; this.maybeStartCaption(); });
				break;
			case 'publish-ready': this.sfu.publishReady(String(m.connectionId ?? ''), String(m.requestId ?? '')); break;
			case 'subscribe': this.sfu.subscribe((m.tracks as { sessionId: string }[]) ?? [], String(m.connectionId ?? '')); break;
			case 'renegotiate-answer': this.sfu.answer(String(m.sdp ?? ''), String(m.connectionId ?? '')); break;

			// captions (soniox-style subscription → our sherpa path)
			case 'caption-subscribe': {
				this.captionSubscribed = !!m.on;
				this.captionSubscription = Number(m.subscription ?? 0);
				const want = !!m.on || (s?.ai.transcription === true && this.publishDone);
				// prod only sends this on real state changes (keyed sync) and
				// restarts its capture worklet on every designation — re-emit so
				// a silently-dead worklet re-arms instead of staying designated
				if (want && this.captionSourceSent) this.captionSourceSent = false;
				this.designateCaption(want);
				break;
			}
			case 'caption-source-ready': {
				this.captionFails = 0;
				const generation = this.captionGen;
				this.captionSampleRate = Number(m.sampleRate ?? m.rate ?? 16000) || 16000;
				this.frame({ t: 'caption-ticket', generation, path: `/ws/caption/${this.code}?gen=${generation}`, expiresAt: Date.now() + 600_000 });
				this.frame({ t: 'caption-state', state: 'live', generation });
				break;
			}
			case 'caption-source-failed': {
				// prod's capture worklet failed — re-arm designation so the app
				// re-opens the caption socket under a fresh generation. Bound it:
				// rapid consecutive failures back off geometrically or we spin a
				// designate→fail loop thousands of generations deep
				this.captionSourceSent = false;
				this.frame({ t: 'caption-state', state: 'degraded', reason: 'source_failed' });
				const fails = ++this.captionFails;
				const arm = () => {
					if (this.captionSubscribed || s?.ai.transcription === true) this.designateCaption(true);
				};
				if (fails <= 2) arm();
				else {
					this.captionFailTimer?.();
					const t = window.setTimeout(arm, Math.min(2000 * (fails - 2), 10_000));
					this.captionFailTimer = () => window.clearTimeout(t);
				}
				break;
			}
			case 'stt-active': break; // heartbeat of their capture pipeline — no state needed

			// speech streams: PCM16 multiplexed over this socket → local sherpa ASR.
			// engine:'translation' gets the ASR→translate→TTS lane instead
			// (tr-caption deltas + caption-audio fan out to listening peers).
			case 'stt-token':
				this.frame({ t: 'stt-token', token: crypto.randomUUID(), expiresAt: Date.now() + 600_000, engine: 'deepgram' });
				break;
			case 'speech-open': {
				// engine:'translation' is the subscriber's receive channel (no PCM
				// flows on it) — fanout runs on the source's ASR pipes instead.
				// prod re-arms capture with a fresh stream id without closing the
				// old one; only one stream per lane is ever live, so retire the
				// previous same-lane pipes (each holds a wasm recognizer)
				const isTr = m.engine === 'translation';
				for (const [id, p] of this.speechStreams)
					if ((p instanceof TranslationSpeechPipe) === isTr) {
						p.dispose();
						this.speechStreams.delete(id);
					}
				const pipe = isTr
					? new TranslationSpeechPipe(String(m.id), Number(m.sampleRate) || 24000, this.sock.emitter())
					: new SpeechStreamPipe(String(m.id), Number(m.sampleRate) || 16000, this.sock.emitter(), s, this.selfProdId, this.trFanout());
				this.speechStreams.set(pipe.id, pipe);
				void pipe.init().then((ok) => { if (!ok) this.speechStreams.delete(pipe.id); });
				break;
			}
			case 'speech-frame':
				this.speechStreams.get(String(m.id))?.frame(String(m.data ?? ''), m.binary === true);
				break;
			case 'speech-close': {
				const pipe = this.speechStreams.get(String(m.id));
				pipe?.dispose();
				this.speechStreams.delete(String(m.id));
				break;
			}
			case 'transcript': {
				const text = String(m.text ?? '').trim();
				if (s && text) s.appendCaption(text, true);
				break;
			}

			// translation — all on-device: langs announce via tr-lang realtime,
			// translation engine stream runs sherpa ASR + wllama + sherpa TTS
			case 'participant-translation': {
				if (s) s.setLangs(String(m.lang ?? 'en'), Array.isArray(m.langs) ? m.langs.map(String) : []);
				if (m.mintSecret) {
					this.frame({
						t: 'translation-secret',
						secret: crypto.randomUUID().replaceAll('-', ''),
						expiresAt: Date.now() + 30 * 60_000,
						lang: String(m.lang ?? 'en'),
						model: 'local-sherpa'
					});
				}
				break;
			}
			case 'translation-active': s?.setTranslationActive(!!m.on); break;
			case 'translate-transcript': {
				const lang = String(m.lang ?? 'en');
				const source = s?.transcriptText() ?? '';
				if (!source.trim()) {
					this.frame({ t: 'transcript-translated', lang, text: '' });
					break;
				}
				const text = await translateText(source, lang);
				if (text === null)
					this.frame({ t: 'error', code: 'translation_unavailable', message: 'Local translation model is not deployed — run scripts/fetch-models.sh.' });
				else
					this.frame({ t: 'transcript-translated', lang, text });
				break;
			}
			case 'account-link-start': {
				const ch = startLink(this.code);
				// prod sets popup.location.href = loginUrl on an about:blank
				// window — resolve against our own origin so that assignment
				// can't land on about:blank's own (empty) base URI
				this.frame({
					t: 'account-link-challenge',
					requestId: m.requestId,
					challengeId: ch.challengeId,
					pollSecret: ch.pollSecret,
					loginUrl: new URL(ch.loginUrl, location.origin).href,
					expiresAt: ch.expiresAt
				});
				break;
			}
			case 'account-link-poll': {
				const accountId = pollLink(String(m.challengeId ?? ''), String(m.pollSecret ?? ''));
				if (accountId) this.frame({ t: 'account-linked', accountId });
				break;
			}
			case 'set-translation-voice': s?.setAi({ voice: String(m.voice ?? m.name ?? '') }); break;
			case 'set-test-stt': case 'stt-debug': break; // engine selection/debug hints — local sherpa is the only engine
			case 'metric': case 'flux-turn': break; // client telemetry/turn hints — no server metric sink exists
			default:
				console.debug('[cic-bridge] unhandled frame', m.t);
		}
	}

	/**
	 * Designate this client as a caption source (or release it). Prod's server
	 * does this when a caption subscriber exists; in the local engine live
	 * transcription IS the caption consumer, so publishing while transcription
	 * is on designates the source. Idempotent — prod restarts its capture
	 * worklet on every caption-source{on:true}, so we never re-send.
	 */
	private designateCaption(on: boolean) {
		if (on === this.captionSourceSent) return;
		this.captionSourceSent = on;
		if (on) {
			const generation = ++this.captionGen;
			// prod's caption-capability handler REPLACES features.captions with
			// l.capability — it must carry the whole capability block (available/
			// epoch included) or `allowed` goes false and the designation is wiped
			this.frame({ t: 'caption-capability', capability: { provider: 'soniox', available: true, epoch: 'sherpa-local', translationAudioEnabled: false }, generation });
			this.frame({ t: 'caption-source', generation, on: true });
		} else if (this.captionGen) {
			this.frame({ t: 'caption-source', generation: this.captionGen, on: false });
		}
	}

	/** prod captures mic only once allowed+stream exist — publish completion is our signal */
	private maybeStartCaption() {
		if (!this.publishDone) return;
		if (this.captionSubscribed || this.session?.ai.transcription === true) this.designateCaption(true);
	}

	// a newer socket adopted our session — go inert: stop emitting deltas but
	// keep answering ping so prod's stale client doesn't reconnect-loop into us
	private retire(): void {
		this.retired = true;
		this.stopFx?.();
		this.stopFx = null;
		this.sfu.dispose();
		this.speaking.dispose();
		this.captionFailTimer?.();
		this.captionFailTimer = null;
		for (const pipe of this.speechStreams.values()) pipe.dispose();
		this.speechStreams.clear();
		// the session belongs to the new bridge — detach so a later socket close
		// doesn't schedule its teardown
		this.session = null;
	}

	async leave() {
		this.stopFx?.();
		this.sfu.dispose();
		this.speaking.dispose();
		this.captionFailTimer?.();
		this.captionFailTimer = null;
		for (const pipe of this.speechStreams.values()) pipe.dispose();
		this.speechStreams.clear();
		if (this.session) {
			const s = this.session;
			// drop the targeted-send registration — the socket is gone
			const byPeer = bridgesByPeer.get(this.code);
			if (byPeer?.get(s.selfId) === this) {
				byPeer.delete(s.selfId);
				if (!byPeer.size) bridgesByPeer.delete(this.code);
			}
			const entry = sessionByCode.get(this.code);
			// another live bridge owns this session (stale/retired socket) —
			// don't schedule its teardown
			const owned = !!bridgesByPeer.get(this.code)?.has(s.selfId);
			if (entry?.session === s && !this.explicitLeave && !owned) {
				// grace window for the reconnecting socket — only a real absence
				// (tab close / explicit leave) expires into a mesh leave
				clearTimeout(entry.leaveTimer);
				entry.leaveTimer = window.setTimeout(() => {
					sessionByCode.delete(this.code);
					void s.leave();
				}, REJOIN_GRACE_MS);
			} else if (!owned) {
				if (entry?.session === s) sessionByCode.delete(this.code);
				await s.leave();
			}
			this.session = null;
		}
	}

	// ---------------------------------------------------------------- session → frames

	private watch() {
		const s = this.session!;
		s.onReaction = (kind, fromId, name) =>
			this.frame({ t: 'reaction', kind, from: name, fromId: this.prodId(fromId) });

		this.stopFx = $effect.root(() => {
			// stick + turn order
			$effect(() => {
				const stick = this.stickObj();
				const nextId = this.nextId();
				const mode = s.mode;
				const direction = s.direction;
				this.delta([
					{ op: 'mode', mode, stick, nextId },
					{ op: 'direction', direction, nextId }
				]);
			});
			// participants: join/leave/rename/mute/hand/away/sharing diffs
			let prevIds = new Set<string>();
			$effect(() => {
				const ids = new Set([s.selfId, ...s.activePeers]);
				const ops: Record<string, unknown>[] = [];
				for (const id of ids) if (!prevIds.has(id) && id !== s.selfId) ops.push({ op: 'join', participant: this.participantOf(id) });
				for (const id of prevIds) if (!ids.has(id)) { ops.push({ op: 'leave', id: this.prodId(id) }); this.prevTracks.delete(id); }
				for (const id of ids) {
					const p = this.participantOf(id);
					ops.push(
						{ op: 'rename', id: p.id, name: p.name },
						{ op: 'muted', id: p.id, muted: p.muted },
						{ op: 'hand', id: p.id, at: p.handRaisedAt },
						{ op: 'away', id: p.id, away: !!p.away },
						{ op: 'sharing', id: p.id, on: !!p.sharing }
					);
					// granular tracks op — prod patches the participant's track list
					const tracksJson = JSON.stringify(p.tracks);
					if (this.prevTracks.get(id) !== tracksJson) {
						this.prevTracks.set(id, tracksJson);
						ops.push({ op: 'tracks', id: p.id, tracks: p.tracks });
					}
				}
				prevIds = ids;
				this.delta(ops);
			});
			// authority + co-hosts + room flags — dedupe by payload: heartbeat
			// recomputes give state objects fresh identities every tick, and an
			// identical delta still bumps seq (a missed one becomes a resync gap)
			let prevCfg = '';
			$effect(() => {
				const ops = [
					{ op: 'host', id: s.authorityId ? this.prodId(s.authorityId) : null },
					{ op: 'co-hosts', ids: s.coHostIds.map((id) => this.prodId(id)) },
					{ op: 'lobby', enabled: s.lobbyEnabled },
					{ op: 'heart', on: s.heartMode },
					{ op: 'host-locks', locks: s.hostLocks },
					{ op: 'ai', ...s.ai },
					{ op: 'milo-wake', mode: s.miloWake },
					{ op: 'started', on: s.started },
					{ op: 'turn-timer', minutes: s.turnTimerMinutes },
					{ op: 'speaking-timer', enabled: s.speakingTimerEveryone },
					{ op: 'tr-fanout', lanes: s.trFanout },
					{ op: 'appearance', ...s.appearance },
					{ op: 'ai-speaking', on: s.miloState === 'speaking' }
				];
				const key = JSON.stringify(ops);
				if (key === prevCfg) return;
				prevCfg = key;
				this.delta(ops);
			});
			// waiting room
			let prevWaiting = new Set<string>();
			$effect(() => {
				const ids = new Set(s.waiting.map((w) => w.id));
				const ops: Record<string, unknown>[] = [];
				for (const w of s.waiting)
					if (!prevWaiting.has(w.id))
						ops.push({ op: 'waiting-join', participant: { id: w.id, name: w.name, joinedAt: w.joinedAt, connected: true, muted: { audio: true, video: true }, tracks: [] } });
				for (const id of prevWaiting) if (!ids.has(id)) ops.push({ op: 'waiting-leave', id });
				prevWaiting = ids;
				this.delta(ops);
			});
			// chat tail
			$effect(() => {
				const log = s.chatLog;
				for (const c of log.slice(this.lastChatLen)) {
					if (c.from === s.selfId) continue; // already echoed on send
					this.frame({ t: 'chat', entry: { id: crypto.randomUUID(), from: this.prodId(c.from), name: s.names[c.from] ?? 'Peer', text: c.text, at: Date.now(), whisper: c.whisper } });
				}
				this.lastChatLen = log.length;
			});
			// captions → prod caption-update + transcript
			$effect(() => {
				const caps = s.captions;
				for (const c of caps.slice(this.lastCapLen)) {
					const update = {
						sourceId: this.prodId(c.from),
						generation: 'local',
						subscription: this.captionSubscription,
						sequence: this.seq + 1,
						state: 'live',
						at: Date.now(),
						sections: [{ id: 1, original: { final: c.final ? c.text : '', partial: c.final ? '' : c.text }, translation: { final: '', partial: '' } }]
					};
					if (this.captionSubscribed) this.frame({ t: 'caption-update', update });
					if (c.final)
						this.frame({ t: 'transcript', entry: { id: crypto.randomUUID(), at: Date.now(), name: c.from === s.selfId ? this.name : (s.names[c.from] ?? 'Peer'), text: c.text } });
				}
				this.lastCapLen = caps.length;
			});
			// caption source designation — s.ai.transcription is reactive, so this
			// fires when the host toggles transcription; publishDone is checked
			// imperatively (maybeStartCaption) since it isn't session state
			$effect(() => {
				this.designateCaption(s.ai.transcription === true && this.publishDone);
			});
			// remote personal-caption sections → prod caption-update frames
			$effect(() => {
				for (const [pid, update] of Object.entries(s.captionSections)) {
					const u = update as { generation?: unknown; sequence?: unknown };
					const key = `${pid}:${String(u.generation)}:${String(u.sequence)}`;
					if (this.seenCaptionSections.has(key)) continue;
					this.seenCaptionSections.add(key);
					this.frame({ t: 'caption-update', update: { ...update, sourceId: this.prodId(pid) } });
				}
			});
			// recording + consent — sessions emit while pending (drives prod's
			// Recording notice dialog); recording-ready resolves the starter's
			// pending request once consent completes and the op lands
			$effect(() => {
				this.frame({
					t: 'recording-state',
					active: s.recording,
					sessions: this.recordingSessions(),
					by: this.prodId(s.recordingProposer ?? s.selfId)
				});
				if (s.recording && this.pendingRecordReq) {
					this.frame({ t: 'recording-ready', requestId: this.pendingRecordReq });
					this.pendingRecordReq = null;
				}
			});
			// notes
			$effect(() => {
				this.frame({ t: 'notes-state', text: s.notesText });
			});
			// host broadcast → prod broadcastMsg banner (own page already sent it)
			let lastBroadcast: typeof s.breakoutBroadcast = null;
			$effect(() => {
				const b = s.breakoutBroadcast;
				if (b && b !== lastBroadcast) {
					lastBroadcast = b;
					this.frame({ t: 'breakout-broadcast', message: b.message, from: s.names[b.from] ?? 'Host' });
				}
			});
			// breakout invitation → channel move (prod breakout-move) + join the
			// channel's media session locally
			$effect(() => {
				if (s.pendingBreakout) {
					const ch = Number(s.pendingBreakout);
					this.frame({ t: 'breakout-move', channel: ch });
					void (ch > 0 ? s.joinBreakout(String(ch)) : s.returnFromBreakout());
				}
			});
			// breakout open/close + roster channel changes → prod applies a fresh
			// snapshot (breakouts/channel are snapshot-replaced, not delta ops)
			$effect(() => {
				void s.breakoutCount;
				void JSON.stringify(s.breakoutChannels);
				untrack(() => this.frame({ t: 'snapshot', room: this.snapshot(), seq: ++this.seq }));
			});
			// mesh streams → SFU pull announcements + speaking detection feeds
			$effect(() => {
				void s.remoteStreams;
				this.sfu.notifyStreams();
				this.speaking.setStreams(s.localMedia?.stream ?? null, s.remoteStreams, s.selfId);
			});
			// Milo stop → prod ai-stopped op {by, eventId} (notice consumed once)
			$effect(() => {
				const n = s.miloStopNotice;
				if (n) {
					this.delta([{ op: 'ai-stopped', by: this.prodId(n.by), eventId: n.eventId }]);
					s.miloStopNotice = null;
				}
			});
			// inbound translated segments — the remote source's device translated
			// its ASR for our declared langs; emit prod frames on our room socket
			$effect(() => {
				const q = s.inboundTr;
				for (const raw of q.slice(this.lastTrLen)) {
					const m = raw as { lang: string; which: string; delta: string; sourceId: string; generation: string; cueId?: number; original?: string; pcm?: string };
					// audio follow-ups arrive as pcm-only segments (delta:'') —
					// text was already delivered; don't emit an empty caption line
					if (m.delta) this.frame({ t: 'tr-caption', lang: m.lang, which: m.which, delta: m.delta });
					if (m.pcm)
						this.frame({
							t: 'caption-audio', sourceId: this.prodId(String(m.sourceId)),
							generation: m.generation, sequence: m.cueId, pcm: m.pcm,
							cue: { id: m.cueId, text: m.delta, original: m.original }
						});
				}
				this.lastTrLen = q.length;
			});
			// transcription off → prod clears the caption view (caption-clear per source)
			let prevTranscription = s.ai.transcription;
			$effect(() => {
				const on = s.ai.transcription === true;
				if (prevTranscription && !on) {
					this.frame({ t: 'caption-clear', sourceId: this.selfProdId });
					for (const pid of Object.keys(s.captionSections))
						this.frame({ t: 'caption-clear', sourceId: this.prodId(pid) });
				}
				prevTranscription = s.ai.transcription;
			});
			// lobby entry — a member confirmed our lobby-join (lobby-wait): we're
			// moved into the waiting list; prod re-renders from the new snapshot
			let prevWaitingSelf = s.waitingSelf;
			$effect(() => {
				if (s.waitingSelf !== prevWaitingSelf) {
					prevWaitingSelf = s.waitingSelf;
					this.frame({ t: 'snapshot', room: this.snapshot(), seq: ++this.seq });
				}
			});
			// lobby admission — a manager's `admit` realtime landed for us: prod
			// expects the targeted `admitted` frame + a snapshot where we're seated
			let admittedSent = false;
			$effect(() => {
				if (s.admitted && !admittedSent) {
					admittedSent = true;
					this.frame({ t: 'admitted' });
					this.frame({ t: 'snapshot', room: this.snapshot(), seq: ++this.seq });
				}
			});
			// remote force-mute landed on us → prod's targeted force-muted frame
			$effect(() => {
				const n = s.forceMuteNotice;
				if (n) {
					s.forceMuteNotice = null;
					this.frame({ t: 'force-muted', kind: n.kind });
				}
			});
			// finalized recording artifacts landed in /rec-local → recordings list
			let lastArtSeq = 0;
			$effect(() => {
				if (s.artifactSeq !== lastArtSeq) {
					lastArtSeq = s.artifactSeq;
					const items = this.recordingsItems();
					if (items.length) this.frame({ t: 'recordings', items });
				}
			});
			// lifecycle terminations → prod terminal frames + socket close
			$effect(() => {
				if (this.terminated) return;
				const terminal = () => {
					this.terminated = true;
					pendingFrames.delete(this.pendingKey);
					pendingRecordReqs.delete(this.pendingKey);
				};
				if (s.accessDenied) {
					// a member denied our password proof — prod prompts and the user
					// retries; the retry must be a FRESH session (new mesh id → new
					// hello → new cap[2] verification), so this one is torn down
					console.debug('[cic-ws] denied: member access-denied');
					terminal();
					this.frame({ t: 'error', code: 'password_required', message: 'This circle is password-protected.' });
					this.sock.close();
					sessionByCode.delete(this.code);
					void s.leave();
				} else if (s.ejected) {
					terminal();
					this.frame({ t: 'removed' });
					this.frame({ t: 'circle_closed', reason: 'removed', message: 'The host removed you from this circle.' });
					this.sock.close();
				} else if (s.lobbyDeclined) {
					terminal();
					this.frame({ t: 'circle_closed', reason: 'declined', message: 'The host declined your join request.' });
					this.sock.close();
				} else if (s.roomEnded) {
					terminal();
					this.frame({ t: 'circle_closed', reason: 'ended', message: 'This circle has ended.' });
					this.sock.close();
				}
			});
		});
	}
}

/** SFU loopback is driven through the bridge for frame emission */
export type { Frame as CicFrame };
