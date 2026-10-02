import { createActor } from 'xstate';
import { stickMachine } from '../domain/stick.machine';
import { openRoom, type RoomHandle } from '../net/room';
import type { OpEnvelope, RealtimeMessage, RoomState } from '../wire/messages';
import { createIdentity, registerPeerKey, dropPeerKey, canonicalBytes, type Identity } from '../crypto/identity';
import { OpLog, authorityOf, LEASE_MS } from '../authority/authority';
import { E2EESession } from '../crypto/e2ee';
import { denyReasons, initPolicy, policyLoaded, type Actor } from '../policy/engine';
import { electAll, type Capability, type Role } from '../roles/auction';
import { capture, wireE2EE, type LocalMedia } from '../media/capture';
import { Recorder } from '../rec/recorder';
import { NotesDoc } from '../notes/notes';
import { BreakoutSession } from '../net/breakout.svelte';
import { LocalTts } from '../ai/speech';
import { llmModelUrl } from '../ai/translate';
import { Milo } from '../ai/milo';
import { bytesToHex } from '@noble/hashes/utils.js';
import { noteArtifact } from '../bridge/artifacts';
import {
	JOIN_PROOF_WINDOW_MS,
	activePeersOf,
	authorityListOf,
	seatedIdsOf,
	shouldAnnounceOnReplay,
	shouldDenyHello,
	shouldHoldOnJoin,
	shouldHonorAccessDenied,
	shouldHonorLobbyWait,
	shouldWaitlist,
	type GateView
} from './gates';

/** same MediaStreamTrack set (ids), regardless of order — used to dedupe
 *  onPeerStream refires that carry no actual track change */
function sameTrackIds(a: MediaStreamTrack[], b: MediaStreamTrack[]): boolean {
	if (a.length !== b.length) return false;
	const ids = new Set(a.map((t) => t.id));
	return b.every((t) => ids.has(t.id));
}

/**
 * Room session — composition root for the declarative stack:
 *   Trystero transport + XState stick + zod wire + OPA policy +
 *   OpLog (signed, epoch-fenced) + RoomRatchet (SFrame E2EE) +
 *   capability auction (authority/milo/recorder roles) + Recorder.
 */

export class RoomSession {
	handle: RoomHandle;
	identity: Identity;
	oplog: OpLog;
	e2ee: E2EESession;
	stick = createActor(stickMachine);
	recorder: Recorder;
	notes: NotesDoc;

	selfMuted = $state(true); // join muted — never auto-open the mic
	videoMuted = $state(true);
	peers = $state<string[]>([]);
	names = $state<Record<string, string>>({});
	caps = $state<Record<string, Capability>>({});
	roles = $state<Record<Role, string | null> | null>(null);
	// authority = lex-min among SEATED peers (see `authorityId` below — declared
	// after waitingSelf/admitted because $derived reads them)
	stickHolderId = $derived(this.stick.getSnapshot().context.holderId);
	stickState = $derived(this.stick.getSnapshot().value);
	stickCtx = $derived(this.stick.getSnapshot().context);
	chatLog = $state<{ from: string; text: string; whisper?: boolean }[]>([]);
	captions = $state<{ from: string; text: string; final: boolean }[]>([]);
	raisedHands = $state<Set<string>>(new Set());
	consentAsked = $state(false); // someone proposed recording — dialog shown
	consents = $state<Record<string, 'granted' | 'denied'>>({});
	recordingProposer = $state<string | null>(null); // mesh peerId that proposed
	recording = $state(false);
	e2eeActive = $state(false);
	breakoutCount = $state(0);
	pendingBreakout = $state<string | null>(null);
	breakout = $state<BreakoutSession | null>(null);
	/** mesh peerId → breakout channel (0 = main circle) — feeds prod's breakouts.roster */
	breakoutChannels = $state<Record<string, number>>({});
	breakoutFreeJoin = $state(false);
	breakoutAllowReturn = $state(true);
	breakoutNames = $state<string[]>([]);
	breakoutBroadcast = $state<{ message: string; from: string } | null>(null);
	remoteStreams = $state<Record<string, MediaStream>>({});
	localMedia: LocalMedia | null = null;
	captionsAvailable = $state(false);
	/** latest personal-caption update per mesh peer (prod caption-update shape) */
	captionSections = $state<Record<string, Record<string, unknown>>>({});
	miloState = $state<'off' | 'standby' | 'listening' | 'speaking'>('off');
	miloStopNotice = $state<{ by: string; eventId: string } | null>(null); // last stop-ai (peerId + event)
	/** sha256(code + ':' + password) — '' means cleared; enforced per-bridge at hello */
	passwordHash = $state('');
	/** our own proof hash, set by the bridge from hello.password before join */
	accessHash = '';
	/** peers that failed the access proof — denied by us, excluded from seats */
	deniedPeers = new Set<string>();
	/** identity keys (hello cap[0]) of peers that passed the access gate — a
	 *  member reconnecting with the same key is not re-gated (they may
	 *  legitimately lack cap[2], e.g. joined before the password was set) */
	private memberKeys = new Set<string>();
	accessDenied = $state(false); // a member denied our proof — bridge closes the socket
	ejected = $state(false); // host removed us — bridge emits removed + circle_closed
	lobbyDeclined = $state(false); // host declined our waiting-room request
	waitingSelf = $state(false); // a member confirmed our lobby-join — we're in the waiting room
	admitted = $state(false); // a manager's admit realtime landed for us — bridge emits prod `admitted`
	forceMuteNotice = $state<{ kind: 'audio' | 'video' } | null>(null); // mute-set landed on us — bridge emits force-muted
	lobbyAnnounced = false; // sent lobby-join once after observing lobby-set
	joinedAtMs = 0; // session.join() timestamp — access-denied only honored inside the join window
	/** peers we held at onPeerJoin because our lobbyEnabled was already on —
	 *  converged view = locally held ∪ manager-broadcast waiting list */
	private heldLocal = new Set<string>();
	private get heldPeers(): Set<string> {
		return new Set([...this.heldLocal, ...this.waiting.map((w) => w.id)]);
	}
	/** authority = lex-min among SEATED peers — held (lobby) and denied peers
	 *  can't take authority over the room; while we're waiting we exclude
	 *  ourselves so every session agrees on the same authority */
	authorityId = $derived(
		authorityOf(authorityListOf(this.selfId, this.activePeers, this.waitingSelf))
	);
	roomEnded = $state(false); // room-end op applied — bridge emits circle_closed
	/** mesh peerId → declared caption/translation languages (drives tr-fanout lanes) */
	peerLangs = $state<Record<string, string[]>>({});
	selfLangs = $state<string[]>([]);
	selfLang = $state('en');
	translationActive = $state(false); // prod translation-active{on} — personal translation flowing
	/** tr-segment payloads addressed to us — bridge drains into tr-caption/caption-audio */
	inboundTr = $state<Record<string, unknown>[]>([]);

	// --- production-parity room state (authored via signed ops; bridged to prod frames) ---
	mode = $state<'open_round' | 'circle_round'>('circle_round');
	direction = $state<'sunwise' | 'earthwise'>('sunwise');
	heartMode = $state(false); // heart-sharing: recording + transcription forced off
	lobbyEnabled = $state(false);
	started = $state(true);
	coHostIds = $state<string[]>([]);
	hostLocks = $state<Record<string, boolean>>({});
	miloWake = $state<'hey_milo' | 'click'>('click');
	transcriptScope = $state<'off' | 'holder' | 'all'>('off'); // matches production default "Transcript off"
	turnTimerMinutes = $state(0);
	speakingTimerEveryone = $state(false);
	trFanout = $state<string[]>([]);
	appearance = $state<Record<string, string | undefined>>({});
	ai = $state<{
		name?: string; enabled?: boolean; transcription?: boolean; contextProcessing?: boolean;
		instructions?: string; voice?: string; standby?: boolean; scope?: string; storeTranscript?: boolean;
	}>({ name: 'Milo' });
	waiting = $state<{ id: string; name: string; joinedAt: number }[]>([]);
	peerMuted = $state<Record<string, { audio: boolean; video: boolean }>>({});
	peerAway = $state<Set<string>>(new Set());
	peerSharing = $state<Set<string>>(new Set());
	notesText = $state('');
	joinedAt = $state<Record<string, number>>({});
	remoteMutedBy = $state<Record<string, 'audio' | 'video' | null>>({});
	onReaction: ((kind: string, fromId: string, name: string) => void) | null = null;
	onTranscript: ((entry: { id: string; at: number; name: string; text: string }) => void) | null = null;

	private heartbeat = 0;
	private stickAlive = true; // leave() stops the actor — late sends on a stopped actor warn
	private sendStick(ev: Parameters<typeof this.stick.send>[0]) {
		if (this.stickAlive) this.stick.send(ev);
	}
	private milo = new Milo();
	private tts = new LocalTts();
	private ttsReady: boolean | null = null;
	private transcriptWindow: string[] = [];
	private publishedStreams = new Set<MediaStream>();

	constructor(
		public roomSecret: string,
		public displayName: string,
		public roomCode: string
	) {
		this.identity = createIdentity('');
		this.handle = openRoom(roomSecret);
		this.e2ee = new E2EESession(this.handle);
		this.recorder = new Recorder(roomCode);
		this.notes = new NotesDoc(this.handle);
		this.oplog = new OpLog(this.identity, (env) =>
			denyReasons(env.op, this.actorFor(env.senderId), this.stateSnapshot())
		);
		this.stick.start();
		this.policyReady = initPolicy();
		(globalThis as { __room?: RoomHandle }).__room = this.handle; // e2e/debug handle

		this.handle.onPeerJoin((peerId) => {
			if (!this.peers.includes(peerId)) this.peers = [...this.peers, peerId];
			this.joinedAt[peerId] = Date.now();
			this.handle.sendRealtime(this.helloMsg(), peerId); // targeted hello so the joiner gets our keys
			// mute state only travels on transitions — a late joiner never saw
			// ours, so default-unmuted reporting makes prod's stall monitor read
			// a locally-muted (silent) track as a transport stall and rejoin
			this.handle.sendRealtime({ t: 'muted', audio: this.selfMuted, video: this.videoMuted }, peerId);
			// late joiners never saw our live op broadcasts — replay the signed
			// log so they learn lobby/password/breakout state (deduped by opId)
			if (this.oplog.entries.length)
				this.handle.sendRealtime({ t: 'op-sync', ops: [...this.oplog.entries] }, peerId);
			// lobby: a NEW joiner is held out of seats — lobby-join moves her
			// to the waiting room, admit seats her. A session that announced
			// itself (learned lobby via replay → lobbyAnnounced) IS a joiner,
			// not a gatekeeper: it sees every member's onPeerJoin at connect
			// and must never hold them (holding a member shrinks activePeers
			// → divergent authority → replayed ops policy-fail on one view).
			if (shouldHoldOnJoin(peerId, this.gateView())) {
				this.heldLocal.add(peerId);
				// tell the joiner she's held — an unannounced hold leaves her
				// self-authoritative if her id is lex-min, and replayed manager
				// ops (lobby-set) then deny on her divergent view forever
				this.handle.sendRealtime({ t: 'lobby-wait' }, peerId);
				return;
			}
			// trystero addStream only reaches already-connected peers — re-offer
			// our published streams to late joiners or they never see our media
			for (const stream of this.publishedStreams) this.offerStream(stream, peerId);
			this.syncSeats();
		});
		this.handle.onPeerLeave((peerId) => {
			this.peers = this.peers.filter((p) => p !== peerId);
			this.waiting = this.waiting.filter((w) => w.id !== peerId);
			this.heldLocal.delete(peerId);
			this.seatedPeers.delete(peerId);
			this.streamOffers.delete(peerId);
			this.peerAway.delete(peerId);
			this.peerSharing.delete(peerId);
			this.peerMuted = { ...this.peerMuted, [peerId]: undefined as never };
			delete this.peerMuted[peerId];
			delete this.remoteStreams[peerId];
			delete this.peerLangs[peerId];
			dropPeerKey(peerId);
			this.syncSeats();
			void this.rotateKeys('leave', peerId); // FS: departed peer can't read new frames
			this.sendStick({ type: 'HOLDER_LOST' }); // orphan deadline: authority refines timing
		});
		this.handle.onPeerStream((stream, peerId) => {
			// trystero can refire onPeerStream for a peer with an equivalent
			// MediaStream (renegotiation, mesh keepalive) without any actual
			// track change. Reassigning the $state record on every call
			// re-triggers the SFU-pull/notifyStreams effect, which re-offers
			// tracks to prod on a shared pc it didn't ask to renegotiate —
			// repeated enough, prod's client treats the media connection as
			// unstable and reconnects its whole room socket. Skip the
			// reassignment (and the cascade) when the track set is unchanged.
			const prev = this.remoteStreams[peerId];
			if (prev && prev.id === stream.id &&
				sameTrackIds(prev.getTracks(), stream.getTracks())) return;
			console.debug('[engine] remote stream', peerId, stream.getTracks().map((t) => t.kind).join('+'));
			this.remoteStreams[peerId] = stream;
		});
		this.handle.onRealtime((msg, peerId) => this.onRealtime(msg, peerId));
		// ops arriving before the policy wasm loads are queued, not denied
		this.handle.onOp((env, peerId) => void this.policyReady.then(() => this.onOp(env, peerId)));

		// authority heartbeat — lease renewal; missed 2x -> takeover via authorityOf()
		this.heartbeat = window.setInterval(() => {
			if (this.authorityId === this.selfId) {
				this.handle.sendRealtime({ t: 'authority-heartbeat', leaseUntil: Date.now() + LEASE_MS });
			}
		}, LEASE_MS / 2);
	}

	get selfId() {
		return this.handle.selfId;
	}

	get selfActor(): Actor {
		return { id: this.selfId, canManageRoom: this.canManage(this.selfId) };
	}

	/** prod's canManageRoom: authority OR co-host */
	canManage(peerId: string): boolean {
		return peerId === this.authorityId || this.coHostIds.includes(peerId);
	}

	private actorFor(peerId: string): Actor {
		return { id: peerId, canManageRoom: this.canManage(peerId) };
	}

	private stateSnapshot(): RoomState {
		return {
			epoch: this.oplog.epoch,
			config: {
				mode: this.mode, direction: this.direction,
				speakingTimerEveryone: this.speakingTimerEveryone, heartMode: this.heartMode,
				transcriptScope: this.transcriptScope, recording: this.recording,
				maxSeats: 12, questionMoments: true
			},
			seats: {}, occupants: {},
			stick: {
				state: this.stickState === 'held' ? 'held' : 'on_table',
				holderId: this.stickHolderId, atSeatOf: this.stickCtx.atSeatOf,
				resumeTo: this.stickCtx.resumeTo, questionActive: this.stickState === 'question'
			},
			recording: { active: this.recording, startedBy: null, consentRequired: true },
			authorityId: this.authorityId,
			roles: {
				miloBrain: this.roles?.['milo-brain'] ?? null,
				miloVoice: this.roles?.['milo-voice'] ?? null,
				recorderPrimary: this.roles?.['recorder-primary'] ?? null,
				recorderStandby: this.roles?.['recorder-standby'] ?? null
			}
		};
	}

	/** peers actually visible to us — denied (bad/missing password) never seat */
	get activePeers(): string[] {
		return activePeersOf(this.peers, this.deniedPeers, this.heldPeers);
	}

	/** pure-gate input — join-window age is read fresh each call */
	private gateView(): GateView {
		return {
			lobbyEnabled: this.lobbyEnabled,
			lobbyAnnounced: this.lobbyAnnounced,
			waitingSelf: this.waitingSelf,
			admitted: this.admitted,
			seatedPeers: this.seatedPeers,
			deniedPeers: this.deniedPeers,
			heldPeers: this.heldPeers,
			memberKeys: this.memberKeys,
			passwordHash: this.passwordHash,
			joinAgeMs: Date.now() - this.joinedAtMs,
			waitingIds: new Set(this.waiting.map((w) => w.id))
		};
	}

	/** probe/debug introspection — read-only view of authority + lobby state */
	debugView() {
		return {
			self: this.selfId, auth: this.authorityId, lobby: this.lobbyEnabled,
			pw: !!this.passwordHash, waitingSelf: this.waitingSelf, admitted: this.admitted,
			peers: [...this.peers], waiting: [...this.waiting.map((w) => w.id)],
			held: [...this.heldPeers], denied: [...this.deniedPeers],
			selfLang: this.selfLang, selfLangs: this.selfLangs, peerLangs: this.peerLangs
		};
	}

	private seatedPeers = new Set<string>(); // peers that ever appeared in seats — lobby announce can't waitlist them
	private streamOffers = new Map<string, Set<string>>(); // peerId → stream ids already offered (addStream throws on a duplicate track)

	/** re-offer a published stream to a peer, skipping tracks already negotiated */
	private offerStream(stream: MediaStream, peerId: string) {
		let offered = this.streamOffers.get(peerId);
		if (!offered) this.streamOffers.set(peerId, (offered = new Set()));
		if (offered.has(stream.id)) return;
		try {
			this.handle.addStream(stream, [peerId]);
			offered.add(stream.id);
		} catch { /* track already negotiated — trystero throws instead of no-op */ }
	}

	private syncSeats() {
		const seats = seatedIdsOf(this.selfId, this.peers, this.gateView());
		for (const p of seats) this.seatedPeers.add(p); // self too — seated self can't be re-waitlisted by a stale lobby-waiting list
		this.sendStick({ type: 'SEATS_SET', seats });
		this.roles = electAll(Object.values(this.caps));
		this.retryAuthOps();
		// milo brain is elected now, but the ~100MB GGUF loads lazily on first address
		if (this.roles?.['milo-brain'] === this.selfId && this.miloState === 'off') this.miloState = 'standby';
	}

	private async rotateKeys(kind: 'join' | 'leave', peerId: string) {
		const announcements = await this.e2ee.onMembershipChange(kind, peerId);
		for (const [to, data] of announcements) {
			this.handle.sendRealtime({ t: 'e2ee-key', epoch: this.e2ee.epoch, data }, to);
		}
		this.e2eeActive = this.e2ee.active;
	}

	/** hello frame — cap[0]=idkey, cap[1]=e2ee key, cap[2]=access proof hash */
	private helloMsg(): RealtimeMessage {
		const cap = [bytesToHex(this.identity.publicKey), this.e2ee.publicKeyHex];
		if (this.accessHash) cap.push(this.accessHash);
		return { t: 'hello', name: this.displayName, cap };
	}

	private onRealtime(msg: RealtimeMessage, peerId: string) {
		switch (msg.t) {
			case 'hello': {
				// password rooms: members verify a JOINER's proof (cap[2]) —
				// the joiner's op-log can't know the hash yet, so the gate lives
				// with established members. We only gate once our own join is
				// proven AND the peer was never seated here: a member's hello
				// legitimately lacks cap[2] (they joined pre-password or the
				// setter never shared plaintext), and denying it poisons our
				// authority/seat view and cascades into replay policy denials.
				if (shouldDenyHello(msg.cap, this.gateView())) {
					this.deniedPeers.add(peerId);
					if (this.canManage(this.selfId)) this.handle.sendRealtime({ t: 'access-denied' }, peerId);
					break;
				}
				this.deniedPeers.delete(peerId);
				if (msg.cap[0]) this.memberKeys.add(msg.cap[0]);
				this.names[peerId] = msg.name;
				// a hello proves the joiner's data channel is live — the
				// onPeerJoin op-sync can fire before it opens, so replay again
				// (opId dedupe makes this a no-op when the first send landed)
				if (this.oplog.entries.length)
					this.handle.sendRealtime({ t: 'op-sync', ops: [...this.oplog.entries] }, peerId);
				// same race as op-sync: the onPeerJoin muted announce can beat
				// the DC open — re-send now that hello proves it live
				this.handle.sendRealtime({ t: 'muted', audio: this.selfMuted, video: this.videoMuted }, peerId);
				if (msg.cap[0]) {
					registerPeerKey(peerId, msg.cap[0]);
					// ops whose signatures couldn't verify before this key arrived
					// (a peer's op-sync replay races the author's hello) retry now
					const pending = this.pendingSigOps.filter((e) => e.senderId === peerId);
					this.pendingSigOps = this.pendingSigOps.filter((e) => e.senderId !== peerId);
					for (const env of pending) this.onOp(env, peerId, true);
				}
				if (msg.cap[1]) {
					this.e2ee.addPeerIdentity(peerId, msg.cap[1]);
					void this.rotateKeys('join', peerId);
				}
				// held peer's hello proves her DC is live — the onPeerJoin
				// lobby-wait may have raced it; re-deliver, and add the waiting
				// entry her lobby-join announce would have created
				if (this.heldLocal.has(peerId) && !this.waiting.some((w) => w.id === peerId)) {
					this.waiting = [...this.waiting, { id: peerId, name: msg.name, joinedAt: Date.now() }]
						.sort((a, b) => a.joinedAt - b.joinedAt);
					this.handle.sendRealtime({ t: 'lobby-wait' }, peerId);
					this.broadcastWaiting();
				}
				this.syncSeats();
				break;
			}
			case 'access-denied':
				// honor only while our own join is unproven — a denied or
				// lobby-held joiner's session denies our hellos in return, and
				// that must never evict an established member. Denials from
				// peers we ourselves denied/held are counter-denials — ignored.
				if (shouldHonorAccessDenied(peerId, this.gateView()))
					this.accessDenied = true;
				break;
			case 'op-sync':
				// member replayed its signed op-log — each envelope re-verifies
				// signature + policy; epoch fencing follows the replayed history
				void this.policyReady.then(() => {
					for (const env of msg.ops) this.onOp(env, peerId, true);
				});
				break;
			case 'chat':
				this.chatLog = [...this.chatLog, { from: peerId, text: msg.text, whisper: !!msg.whisperTo }];
				break;
			case 'caption-update':
				this.captions = [...this.captions.slice(-50), { from: peerId, text: msg.text, final: msg.final }];
				if (msg.final) void this.maybeMilo(msg.text);
				break;
			case 'caption-sections':
				// personal-caption lane sections from a remote source — forwarded to
				// the prod client as caption-update frames (separate from transcript)
				this.captionSections = { ...this.captionSections, [peerId]: msg.update };
				break;
			case 'milo-state':
				this.miloState = msg.state;
				break;
			case 'hand-raise':
				this.raisedHands = new Set([...this.raisedHands, peerId]);
				break;
			case 'hand-lower':
				this.raisedHands.delete(peerId);
				this.raisedHands = new Set(this.raisedHands);
				break;
			case 'recorder-heartbeat':
				// standby promotion: if primary heartbeats stop >2 leases, re-elect
				break;
			case 'e2ee-key':
				void this.e2ee.consumeAnnouncement(msg.data);
				break;
			case 'breakout-assign':
				if (msg.to === this.selfId) {
					this.pendingBreakout = msg.room;
					const ch = Number(msg.room) || 0;
					this.breakoutChannels = { ...this.breakoutChannels, [this.selfId]: ch };
					// broadcast so every member's roster reflects the move
					this.handle.sendRealtime({ t: 'breakout-move', channel: ch });
				}
				break;
			case 'breakout-broadcast':
				this.breakoutBroadcast = { message: msg.text, from: peerId };
				break;
			case 'breakout-return':
				void this.leaveBreakout();
				break;
			case 'away':
				if (msg.on) this.peerAway = new Set([...this.peerAway, peerId]);
				else { this.peerAway.delete(peerId); this.peerAway = new Set(this.peerAway); }
				break;
			case 'sharing':
				if (msg.on) this.peerSharing = new Set([...this.peerSharing, peerId]);
				else { this.peerSharing.delete(peerId); this.peerSharing = new Set(this.peerSharing); }
				break;
			case 'rename':
				this.names[peerId] = msg.name;
				break;
			case 'muted':
				this.peerMuted = { ...this.peerMuted, [peerId]: { audio: msg.audio, video: msg.video } };
				break;
			case 'notes':
				this.notesText = msg.text;
				break;
			case 'ask-ai':
				if (msg.text) void this.maybeMilo(`milo ${msg.text}`);
				else void this.maybeMilo('milo check in');
				break;
			case 'reaction-kind':
				this.onReaction?.(msg.kind, peerId, this.names[peerId] ?? 'Peer');
				break;
			case 'lobby-join':
				// a joiner's announce holds them here even if our onPeerJoin ran
				// before lobby-set applied (op-sync ordering) — converges heldPeers
				// across members. Already-seated peers never announce: only
				// replayed lobby-set triggers it, and they applied it live.
				if (shouldWaitlist(peerId, this.gateView())) {
					this.waiting = [...this.waiting, { id: peerId, name: msg.name, joinedAt: Date.now() }]
						.sort((a, b) => a.joinedAt - b.joinedAt);
					this.handle.sendRealtime({ t: 'lobby-wait' }, peerId);
					this.broadcastWaiting();
				}
				break;
			case 'lobby-wait':
				// a member holds us out of seats — exclude self from the
				// electorate so authority converges to the members' view and
				// replayed manager ops can verify. Join-window gated: a forged
				// wait must never unseat an established member.
				if (shouldHonorLobbyWait(this.gateView())) {
					this.lobbyEnabled = true;
					this.waitingSelf = true;
					this.lobbyAnnounced = true;
					// our announce creates the waiting entry on managers that
					// didn't hold us directly (and re-triggers lobby-waiting)
					this.announceLobbyJoin(this.displayName);
					this.syncSeats();
				}
				break;
			case 'lobby-waiting':
				// a manager's waiting list is authoritative — adopt it so every
				// session agrees who is held out of seats (denied/dropped peers
				// are filtered the same way everywhere)
				if (this.canManage(peerId)) {
					this.waiting = msg.entries.filter((e) => !this.seatedPeers.has(e.id));
					this.syncSeats();
				}
				break;
			case 'admit': {
				// only a manager's admit counts — anyone can forge realtime frames
				if (!this.canManage(peerId)) break;
				if (msg.to === this.selfId) {
					this.admitted = true;
					this.waitingSelf = false;
					this.waiting = this.waiting.filter((x) => x.id !== this.selfId);
					this.heldLocal.delete(this.selfId);
					break;
				}
				const w = this.waiting.find((x) => x.id === msg.to);
				if (w) {
					this.waiting = this.waiting.filter((x) => x.id !== msg.to);
					this.heldLocal.delete(msg.to);
					// held peers never got the join-time stream re-offer — offer now
					for (const stream of this.publishedStreams) this.offerStream(stream, msg.to);
					this.syncSeats();
				}
				break;
			}
			case 'lobby-decline':
				if (msg.to === this.selfId && this.canManage(peerId)) this.lobbyDeclined = true;
				break;
			case 'milo-stop':
				this.applyMiloStop(peerId);
				break;
			case 'tr-lang': {
				this.peerLangs = { ...this.peerLangs, [peerId]: msg.langs };
				this.syncTrFanout();
				break;
			}
			case 'tr-segment':
				if (msg.to === this.selfId)
					this.inboundTr = [...this.inboundTr.slice(-50), msg];
				break;
			case 'breakout-move':
				this.breakoutChannels = { ...this.breakoutChannels, [peerId]: msg.channel };
				break;
			case 'recording-consent':
				if (msg.state === 'pending') {
					this.consentAsked = true;
					this.recordingProposer = peerId;
				} else {
					this.consents[peerId] = msg.state;
					this.maybeStartRecording();
				}
				break;
			case 'recording-state':
				this.recording = msg.active;
				break;
		}
	}

	private pendingSigOps: OpEnvelope[] = [];
	private pendingAuthOps: OpEnvelope[] = [];

	private onOp(env: OpEnvelope, _peerId: string, replay = false) {
		// replay=true for op-sync catch-up — the joiner's fresh log accepts the
		// sender's historical epochs; live ops stay strictly epoch-fenced
		const denies = replay ? this.oplog.applyReplay(env) : this.oplog.apply(env);
		if (denies) {
			// bad signature usually means the author's key hasn't arrived yet —
			// hold the op and retry when their hello registers it
			if (denies.includes('bad signature')) this.pendingSigOps.push(env);
			// manager-gated ops can deny while our authority view is still
			// converging (joiner replaying ops before member hellos/seats land)
			// — hold and retry when authority/seats change; opId dedupe makes a
			// second application harmless
			else if (denies.every((d) => /requires manager/.test(d))) {
				if (!this.pendingAuthOps.some((p) => p.opId === env.opId)) this.pendingAuthOps.push(env);
			}
			// 'replay' = op-sync echo of an op we already applied — expected, not a fault
			else if (!denies.every((d) => d === 'replay'))
				console.warn('[engine] op denied', env.op.t, denies, { from: env.senderId, auth: this.authorityId });
			return;
		}
		this.applyOp(env, replay);
	}

	/** authority/seats changed — re-evaluate held manager-gated ops */
	private retryAuthOps() {
		if (!this.pendingAuthOps.length) return;
		const pending = this.pendingAuthOps;
		this.pendingAuthOps = [];
		for (const env of pending) this.onOp(env, env.senderId, true);
	}

	private applyOp(env: OpEnvelope, replay = false) {
		switch (env.op.t) {
			case 'stick-request': this.sendStick({ type: 'REQUEST', by: env.senderId }); break;
			case 'stick-pass': this.sendStick({ type: 'PASS' }); break;
			case 'stick-give': this.sendStick({ type: 'GIVE', to: env.op.to }); break;
			case 'stick-table': this.sendStick({ type: 'TABLE' }); break;
			case 'stick-resume': this.sendStick({ type: 'QUESTION_END' }); break;
			case 'mode-set': this.mode = env.op.mode; this.sendStick({ type: 'MODE_SET', mode: env.op.mode }); break;
			case 'direction-set': this.direction = env.op.direction; this.sendStick({ type: 'DIRECTION_SET', direction: env.op.direction }); break;
			case 'heart-set':
				this.heartMode = env.op.on;
				// invariant: heart-sharing forces recording + transcription off
				if (env.op.on) {
					if (this.recording) { this.recording = false; void this.finishRecording(); }
					this.captionsAvailable = false;
				}
				break;
			case 'lobby-set':
				this.lobbyEnabled = env.op.enabled;
				if (!env.op.enabled) {
					// lobby off releases everyone held — seat them and offer
					// the streams their join-time hold skipped
					const released = [...this.heldLocal, ...this.waiting.map((w) => w.id)];
					this.heldLocal.clear();
					this.waiting = [];
					for (const p of released)
						if (p !== this.selfId && this.peers.includes(p))
							for (const s of this.publishedStreams) this.offerStream(s, p);
					if (this.waitingSelf) { this.waitingSelf = false; this.admitted = true; }
				}
				this.syncSeats();
				// only a late joiner learning lobby via op-sync replay announces —
				// members applying it live are already seated and must not waitlist
				if (shouldAnnounceOnReplay(replay, env.op.enabled, this.gateView())) {
					this.lobbyAnnounced = true;
					this.announceLobbyJoin(this.displayName);
				}
				break;
			case 'co-host-set': {
				const target = env.op.id;
				this.coHostIds = env.op.on
					? [...new Set([...this.coHostIds, target])]
					: this.coHostIds.filter((id) => id !== target);
				break;
			}
			case 'started-set': this.started = env.op.on; break;
			case 'host-locks-set': this.hostLocks = { ...env.op.locks }; break;
			case 'appearance-set': {
				const { t: _t, ...patch } = env.op;
				this.appearance = { ...this.appearance, ...patch };
				break;
			}
			case 'ai-set': {
				const { t: _t, ...patch } = env.op;
				this.ai = { ...this.ai, ...patch };
				break;
			}
			case 'milo-wake-set': this.miloWake = env.op.mode; break;
			case 'mute-set':
				if (env.op.id === this.selfId) {
					// remote can never force-open — only force-close
					if (env.op.on && env.op.kind === 'audio') this.setSelfMuted(true);
					if (env.op.on && env.op.kind === 'video') this.setVideoMuted(true);
					this.remoteMutedBy[env.op.kind] = env.op.on ? env.op.kind : null;
					if (env.op.on) this.forceMuteNotice = { kind: env.op.kind }; // bridge emits prod force-muted on our socket
				}
				break;
			case 'tr-fanout-set': this.trFanout = [...env.op.lanes]; break;
			case 'turn-timer-set': this.turnTimerMinutes = env.op.minutes; break;
			case 'config-set': {
				const p = env.op.patch;
				if (p.mode) this.sendStick({ type: 'MODE_SET', mode: p.mode });
				if (p.direction) this.sendStick({ type: 'DIRECTION_SET', direction: p.direction });
				if (p.speakingTimerEveryone !== undefined) this.speakingTimerEveryone = p.speakingTimerEveryone;
				if (p.speakingTimerSeconds !== undefined) this.turnTimerMinutes = Math.round(p.speakingTimerSeconds / 60);
				if (p.transcriptScope !== undefined) {
					this.transcriptScope = p.transcriptScope;
					if (p.transcriptScope === 'off') this.captionsAvailable = false;
				}
				if (p.recording === false && this.recording) { this.recording = false; void this.finishRecording(); }
				break;
			}
			case 'recording-start': this.recording = true; this.consentAsked = false; void this.maybeRecord(); break;
			case 'recording-stop':
				this.recording = false;
				this.consents = {};
				this.consentAsked = false;
				this.recordingProposer = null;
				void this.finishRecording();
				break;
			case 'room-end': this.roomEnded = true; void this.leave(); break;
			case 'peer-remove': {
				const id = env.op.id;
				if (id === this.selfId) {
					this.ejected = true;
					void this.leave();
				} else {
					this.peers = this.peers.filter((p) => p !== id);
					this.waiting = this.waiting.filter((w) => w.id !== id);
					delete this.remoteStreams[id];
					this.syncSeats();
				}
				break;
			}
			case 'password-set': this.passwordHash = env.op.hash; break;
			case 'breakout-open':
				this.breakoutCount = env.op.count;
				this.breakoutChannels = {};
				this.breakoutFreeJoin = env.op.freeJoin ?? false;
				this.breakoutAllowReturn = env.op.allowReturn ?? true;
				this.breakoutNames = env.op.names ?? [];
				break;
			case 'breakout-close':
				this.breakoutCount = 0;
				this.breakoutChannels = {};
				this.breakoutNames = [];
				void this.leaveBreakout();
				break;
		}
	}

	private policyReady: Promise<void>;

	emitOp(op: OpEnvelope['op']) {
		if (!policyLoaded()) {
			// queue until the wasm policy is ready — same .then chain preserves order
			void this.policyReady.then(() => this.emitOp(op));
			return;
		}
		const unsigned = { v: 1, t: 'op', opId: crypto.randomUUID(), roomEpoch: this.oplog.epoch, senderId: this.selfId, sentAt: Date.now(), op };
		const sig = this.identity.sign(canonicalBytes(unsigned));
		const env = { ...unsigned, sig } as OpEnvelope;
		const denies = this.oplog.apply(env); // self-apply through the same validation path
		if (denies) {
			console.warn('[engine] op denied', op.t, denies);
			return; // a denied op must never propagate — members would deny it too
		}
		this.applyOp(env);
		this.handle.sendOp(env);
	}

	async join(opts: { capture?: boolean } = {}) {
		const wantCapture = opts.capture !== false;
		if (wantCapture) {
			this.localMedia = await capture({ video: true, audio: true });
			this.localMedia.setMuted(this.selfMuted);
			this.publishedStreams.add(this.localMedia.stream);
			this.handle.addStream(this.localMedia.stream);
		}
		this.joinedAtMs = Date.now();
		wireE2EE(this.handle, this.e2ee);
		registerPeerKey(this.selfId, bytesToHex(this.identity.publicKey));
		this.handle.sendRealtime(this.helloMsg());
		this.handle.sendRealtime({ t: 'muted', audio: this.selfMuted, video: this.videoMuted });
		this.caps[this.selfId] = await measureCapability(this.selfId);
		this.syncSeats();
	}

	/** production-frontend path: media arrives over the loopback SFU — publish it to the mesh */
	publishLocal(stream: MediaStream) {
		this.publishedStreams.add(stream);
		this.handle.addStream(stream);
		this.breakout?.publish(stream);
	}

	/** a caption segment from the speech stream (prod frontend streams PCM via speech-frame) */
	appendCaption(text: string, final: boolean) {
		this.captions = [...this.captions.slice(-50), { from: this.selfId, text, final }];
		this.handle.sendRealtime({ t: 'caption-update', text, final, lang: 'en' });
		if (final) {
			this.storeTranscriptLine(this.names[this.selfId] ?? this.displayName, text);
			void this.maybeMilo(text);
		}
	}

	/** ai.storeTranscript opt-in — lines persist to localStorage for the exit view */
	private storeTranscriptLine(name: string, text: string) {
		if (this.ai.storeTranscript !== true) return;
		try {
			const key = `cic.transcript.${this.roomCode}`;
			const lines = this.storedTranscript();
			lines.push({ name, text });
			localStorage.setItem(key, JSON.stringify(lines.slice(-400)));
		} catch {}
	}

	/** Milo is an elected role — the model downloads only on first address, not on join */
	private miloInitStarted = false;
	private async ensureMilo() {
		if (this.miloInitStarted || this.roles?.['milo-brain'] !== this.selfId) return;
		this.miloInitStarted = true;
		const ok = await this.milo.init({
			modelUrl: await llmModelUrl(),
			maxContextTokens: 2048
		});
		this.miloState = this.milo.state;
		this.milo.onSay = (text) => {
			this.handle.sendRealtime({ t: 'chat', text: `Milo: ${text}` });
			this.chatLog = [...this.chatLog, { from: this.selfId, text: `Milo: ${text}` }];
			void this.speakMilo(text);
			this.handle.sendRealtime({ t: 'milo-state', state: this.milo.state });
		};
		this.handle.sendRealtime({ t: 'milo-state', state: this.milo.state });
		void ok;
	}

	/** direct-address trigger: final transcript lines starting with "milo" */
	private async maybeMilo(text: string) {
		this.transcriptWindow = [...this.transcriptWindow.slice(-39), text];
		if (this.roles?.['milo-brain'] !== this.selfId) return;
		const match = text.trim().match(/^milo[\s,.:;-]+(.+)/i);
		if (!match) return;
		this.miloState = 'listening';
		await this.ensureMilo();
		await this.milo.ask(match[1], this.transcriptWindow);
		this.miloState = this.milo.state;
	}

	private speakCtx: AudioContext | null = null;

	/** milo-voice role synthesizes Milo replies locally via sherpa VITS */
	private async speakMilo(text: string) {
		if (this.roles?.['milo-voice'] !== this.selfId) return;
		if (this.ttsReady === null) this.ttsReady = await this.tts.init();
		if (!this.ttsReady) return;
		const audio = await this.tts.speak(text);
		if (!audio) return;
		const ctx = new AudioContext({ sampleRate: audio.sampleRate });
		this.speakCtx = ctx;
		const buf = ctx.createBuffer(1, audio.samples.length, audio.sampleRate);
		buf.copyToChannel(audio.samples as Float32Array<ArrayBuffer>, 0);
		const node = ctx.createBufferSource();
		node.buffer = buf;
		node.connect(ctx.destination);
		node.onended = () => void ctx.close().then(() => { if (this.speakCtx === ctx) this.speakCtx = null; });
		node.start();
	}

	/** prod's "Stop" on Milo — anyone may rest him; halts in-flight generation + voice */
	stopMilo() {
		this.applyMiloStop(this.selfId);
		this.handle.sendRealtime({ t: 'milo-stop' });
	}

	private applyMiloStop(byPeerId: string) {
		this.milo.interrupt();
		if (this.speakCtx) { void this.speakCtx.close(); this.speakCtx = null; }
		this.miloState = 'standby';
		this.miloStopNotice = { by: byPeerId, eventId: crypto.randomUUID() };
	}

	private async maybeRecord() {
		if (this.roles?.['recorder-primary'] === this.selfId || this.roles?.['recorder-standby'] === this.selfId) {
			await this.recorder.start();
		}
	}

	/** bumps when finalized recording bytes land in /rec-local — bridge emits `recordings` */
	artifactSeq = $state(0);

	/** stop the recorder and publish real segment blobs into the local artifact store */
	private async finishRecording() {
		const blobs = await this.recorder.stop();
		for (const blob of blobs) {
			const key = `local-${crypto.randomUUID()}.webm`;
			try {
				await fetch(`/rec-local/${key}`, { method: 'PUT', body: blob });
				noteArtifact(this.roomCode, key, blob.size);
			} catch {}
		}
		if (blobs.length) this.artifactSeq++;
	}

	requestStick() { this.emitOp({ t: 'stick-request' }); }
	passStick() {
		this.emitOp(this.stick.getSnapshot().context.mode === 'circle_round'
			? { t: 'stick-pass', to: '' }
			: { t: 'stick-table' });
	}
	tableStick() { this.emitOp({ t: 'stick-table' }); }
	raiseHand(up: boolean) {
		this.handle.sendRealtime({ t: up ? 'hand-raise' : 'hand-lower' });
		if (up) this.raisedHands = new Set([...this.raisedHands, this.selfId]);
		else { this.raisedHands.delete(this.selfId); this.raisedHands = new Set(this.raisedHands); }
	}
	/** recording requires universal consent — propose first, start when all grant */
	proposeRecording() {
		this.handle.sendRealtime({ t: 'recording-consent', state: 'pending' });
		this.consentAsked = true;
		this.recordingProposer = this.selfId;
		this.consents[this.selfId] = 'granted';
	}
	answerConsent(granted: boolean) {
		this.consents[this.selfId] = granted ? 'granted' : 'denied';
		this.handle.sendRealtime({ t: 'recording-consent', state: granted ? 'granted' : 'denied' });
		this.consentAsked = false;
		this.maybeStartRecording();
	}
	get allConsented() {
		return this.peers.every((p) => this.consents[p] === 'granted') && this.consents[this.selfId] === 'granted';
	}
	/** the proposer fires the real recording-start op once every member grants */
	private maybeStartRecording() {
		if (this.consentAsked && this.recordingProposer === this.selfId && this.allConsented && !this.recording) {
			this.consentAsked = false;
			this.emitOp({ t: 'recording-start' });
		}
	}
	startRecording() {
		if (!this.allConsented) return this.proposeRecording();
		this.emitOp({ t: 'recording-start' });
	}
	stopRecording() { this.emitOp({ t: 'recording-stop' }); }
	endRoom() { this.emitOp({ t: 'room-end' }); }

	// --- breakouts (authority only per cic.rego) ---
	openBreakouts(count: number, opts: { freeJoin?: boolean; allowReturn?: boolean; names?: string[] } = {}) {
		// strip undefined — the op is signed over canonical bytes and undefined
		// keys would diverge from the JSON-parsed op on the receiving side
		const op: Record<string, unknown> = { t: 'breakout-open', count };
		for (const [k, v] of Object.entries(opts)) if (v !== undefined) op[k] = v;
		this.emitOp(op as OpEnvelope['op']);
	}
	closeBreakouts() { this.emitOp({ t: 'breakout-close' }); }
	assignBreakout(peerId: string, room: string) {
		this.breakoutChannels = { ...this.breakoutChannels, [peerId]: Number(room) || 0 };
		this.handle.sendRealtime({ t: 'breakout-assign', room, to: peerId }, peerId);
	}
	broadcastToBreakouts(text: string) {
		this.handle.sendRealtime({ t: 'breakout-broadcast', text });
	}
	async joinBreakout(roomId: string) {
		this.breakout = new BreakoutSession(this.roomSecret, roomId);
		for (const st of this.publishedStreams) this.breakout.publish(st);
		this.pendingBreakout = null;
	}
	async leaveBreakout() {
		await this.breakout?.leave();
		this.breakout = null;
	}
	async returnFromBreakout() {
		this.breakoutChannels = { ...this.breakoutChannels, [this.selfId]: 0 };
		this.handle.sendRealtime({ t: 'breakout-move', channel: 0 });
		this.handle.sendRealtime({ t: 'breakout-return' });
		await this.leaveBreakout();
	}

	sendChat(text: string, whisperTo?: string) {
		// whisper = DC-targeted frame — only the recipient's client decodes it
		this.handle.sendRealtime({ t: 'chat', text, whisperTo }, whisperTo);
		this.chatLog = [...this.chatLog, { from: this.selfId, text, whisper: !!whisperTo }];
	}

	/** mute sovereignty: self|auto|remote — remote can never force-open */
	setSelfMuted(muted: boolean) {
		this.selfMuted = muted;
		this.localMedia?.setMuted(muted);
		this.handle.sendRealtime({ t: 'muted', audio: muted, video: this.videoMuted });
	}
	setVideoMuted(muted: boolean) {
		this.videoMuted = muted;
		if (this.localMedia) for (const t of this.localMedia.stream.getVideoTracks()) t.enabled = !muted;
		this.handle.sendRealtime({ t: 'muted', audio: this.selfMuted, video: muted });
	}

	// --- bridge-facing API (production frontend commands → signed ops / realtime) ---
	broadcast(msg: RealtimeMessage) { this.handle.sendRealtime(msg); }
	giveStick(to: string) { this.emitOp({ t: 'stick-give', to }); }
	setMode(mode: 'open_round' | 'circle_round') { this.emitOp({ t: 'mode-set', mode }); }
	setDirection(direction: 'sunwise' | 'earthwise') { this.emitOp({ t: 'direction-set', direction }); }
	setHeart(on: boolean) { this.emitOp({ t: 'heart-set', on }); }
	setLobby(on: boolean) { this.emitOp({ t: 'lobby-set', enabled: on }); }
	setCoHost(id: string, on: boolean) { this.emitOp({ t: 'co-host-set', id, on }); }
	setStarted(on: boolean) { this.emitOp({ t: 'started-set', on }); }
	setHostLocks(locks: Record<string, boolean>) { this.emitOp({ t: 'host-locks-set', locks }); }
	setAppearance(patch: Record<string, string>) { this.emitOp({ t: 'appearance-set', ...patch }); }
	setAi(patch: Record<string, unknown>) { this.emitOp({ t: 'ai-set', ...patch }); }
	setMiloWake(mode: 'hey_milo' | 'click') { this.emitOp({ t: 'milo-wake-set', mode }); }
	forceMute(id: string, kind: 'audio' | 'video', on: boolean) { this.emitOp({ t: 'mute-set', id, kind, on }); }
	setTrFanout(lanes: string[]) { this.emitOp({ t: 'tr-fanout-set', lanes }); }
	setTurnTimer(minutes: number) { this.emitOp({ t: 'turn-timer-set', minutes }); }
	setSpeakingTimerEveryone(on: boolean) { this.emitOp({ t: 'config-set', patch: { speakingTimerEveryone: on } }); }
	setTranscription(on: boolean) { this.emitOp({ t: 'config-set', patch: { transcriptScope: on ? 'all' : 'off' } }); }
	announceAway(on: boolean) {
		this.handle.sendRealtime({ t: 'away', on });
		if (on) this.peerAway = new Set([...this.peerAway, this.selfId]);
		else { this.peerAway.delete(this.selfId); this.peerAway = new Set(this.peerAway); }
	}
	announceSharing(on: boolean, audio = false) {
		this.handle.sendRealtime({ t: 'sharing', on, audio });
		if (on) this.peerSharing = new Set([...this.peerSharing, this.selfId]);
		else { this.peerSharing.delete(this.selfId); this.peerSharing = new Set(this.peerSharing); }
	}
	renameSelf(name: string) {
		this.names[this.selfId] = name;
		this.handle.sendRealtime({ t: 'rename', name });
	}
	saveNotes(text: string) {
		this.notesText = text;
		this.handle.sendRealtime({ t: 'notes', text });
	}
	askAi(text?: string) { this.handle.sendRealtime({ t: 'ask-ai', text }); void this.maybeMilo(`milo ${text ?? 'check in'}`); }
	react(kind: string) {
		this.handle.sendRealtime({ t: 'reaction-kind', kind, name: this.names[this.selfId] ?? this.displayName });
		this.onReaction?.(kind, this.selfId, this.names[this.selfId] ?? this.displayName);
	}
	/** lobby: announce a joiner into the waiting list (prod waiting-join).
	 *  Members confirm with lobby-wait — retry a few times if none answered
	 *  (their lobbyEnabled may still be catching up via op-sync). */
	announceLobbyJoin(name: string, attempt = 0) {
		this.handle.sendRealtime({ t: 'lobby-join', name });
		if (attempt < 4 && !this.waitingSelf && !this.admitted)
			setTimeout(() => {
				if (!this.waitingSelf && !this.admitted && !this.lobbyDeclined) this.announceLobbyJoin(name, attempt + 1);
			}, 4000);
	}
	admitWaiting(id: string) {
		if (!this.canManage(this.selfId)) return;
		const w = this.waiting.find((x) => x.id === id);
		if (w) {
			this.waiting = this.waiting.filter((x) => x.id !== id);
			this.heldLocal.delete(id);
			for (const stream of this.publishedStreams) this.offerStream(stream, id);
			this.syncSeats();
		}
		this.handle.sendRealtime({ t: 'admit', to: id });
		this.broadcastWaiting();
	}
	/** lobby "Decline" — drop the waiter and tell them (their socket gets circle_closed) */
	declineWaiting(id: string) {
		if (!this.canManage(this.selfId)) return;
		this.waiting = this.waiting.filter((w) => w.id !== id);
		this.heldLocal.delete(id);
		this.handle.sendRealtime({ t: 'lobby-decline', to: id }, id);
		this.broadcastWaiting();
	}
	/** managers publish the waiting list so every session's held set converges */
	private broadcastWaiting() {
		if (!this.canManage(this.selfId)) return;
		this.handle.sendRealtime({ t: 'lobby-waiting', entries: this.waiting });
	}
	/** host kick — signed op; the target's own session applies it by leaving */
	removePeer(id: string) {
		this.emitOp({ t: 'peer-remove', id });
	}
	/** prod set-password — empty string clears; stored as sha256(code+':'+pw) hash */
	async setPassword(password: string) {
		const { sha256 } = await import('@noble/hashes/sha2.js');
		const hash = password ? bytesToHex(sha256(`${this.roomCode}:${password}`)) : '';
		this.emitOp({ t: 'password-set', hash });
	}
	/** prod hello carries plaintext password — bridge compares against passwordHash */
	async checkPassword(password: string): Promise<boolean> {
		if (!this.passwordHash) return true;
		const { sha256 } = await import('@noble/hashes/sha2.js');
		return bytesToHex(sha256(`${this.roomCode}:${password}`)) === this.passwordHash;
	}
	/** prod participant-translation — declare our caption/translation languages */
	setLangs(lang: string, langs: string[]) {
		this.selfLang = lang;
		this.selfLangs = langs;
		this.handle.sendRealtime({ t: 'tr-lang', lang, langs });
		this.syncTrFanout();
	}

	/** authority owns the tr-fanout op — lanes = union of all declared langs */
	private syncTrFanout() {
		if (!this.canManage(this.selfId)) return;
		const lanes = [...new Set([...this.selfLangs, ...Object.values(this.peerLangs).flat()])]
			.filter((l) => l && l !== 'none');
		if (JSON.stringify(lanes) !== JSON.stringify(this.trFanout)) this.setTrFanout(lanes);
	}
	setTranslationActive(on: boolean) {
		this.translationActive = on;
	}

	/** ship a translated segment to a subscriber — its bridge emits the prod frames */
	sendTrSegment(peerId: string, payload: Omit<RealtimeMessage & { t: 'tr-segment' }, 't' | 'to'>) {
		this.handle.sendRealtime({ t: 'tr-segment', to: peerId, ...payload }, peerId);
	}
	/** transcript text for translate-transcript — stored lines or live caption finals */
	transcriptText(): string {
		const stored = this.storedTranscript();
		if (stored.length) return stored.map((e) => `${e.name}: ${e.text}`).join('\n');
		return this.captions.filter((c) => c.final).map((c) => `${this.names[c.from] ?? 'Peer'}: ${c.text}`).join('\n');
	}
	/** persisted transcript lines — only written while ai.storeTranscript is on */
	storedTranscript(): { name: string; text: string }[] {
		try {
			return JSON.parse(localStorage.getItem(`cic.transcript.${this.roomCode}`) ?? '[]');
		} catch {
			return [];
		}
	}
	hopBreakout(channel: number) {
		this.breakoutChannels = { ...this.breakoutChannels, [this.selfId]: channel };
		this.handle.sendRealtime({ t: 'breakout-move', channel });
	}

	async leave() {
		clearInterval(this.heartbeat);
		await this.finishRecording();
		this.notes.destroy();
		this.localMedia?.stop();
		this.e2ee.dispose();
		this.stickAlive = false;
		this.stick.stop();
		return this.handle.leave();
	}
}

async function measureCapability(peerId: string): Promise<Capability> {
	const nav = navigator as Navigator & { deviceMemory?: number };
	return {
		peerId,
		cpuScore: nav.hardwareConcurrency ?? 2,
		memoryGB: nav.deviceMemory ?? 4,
		batterySaver: false,
		webgpu: 'gpu' in navigator,
		models: [],
		uplinkKbps: 2000,
		isRecorderDevice: false
	};
}
