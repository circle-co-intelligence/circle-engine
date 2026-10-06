import { createActor } from 'xstate';
import { stickMachine } from '../domain/stick.machine';
import { openRoom, type RoomHandle } from '../net/room';
import type { OpEnvelope, RealtimeMessage, RoomState } from '../wire/messages';
import { createIdentity, registerPeerKey, dropPeerKey, canonicalBytes, type Identity } from '../crypto/identity';
import { OpLog, authorityOf, LEASE_MS } from '../authority/authority';
import { E2EESession } from '../crypto/e2ee';
import { denyReasons, initPolicy, policyLoaded, type Actor } from '../policy/engine';
import { electAll, type Capability, type Role } from '../roles/auction';
import { capture, localFeed, onLocalFeed, wireE2EE, type LocalMedia } from '../media/capture';
import { Recorder } from '../rec/recorder';
import { NotesDoc } from '../notes/notes';
import { BreakoutSession } from '../net/breakout.svelte';
import { LocalTts } from '../ai/speech';
import { llmModelUrl } from '../ai/translate';
import { onModel } from '../ai/modelStatus';
import { Milo } from '../ai/milo';
import { MicEar } from '../ai/ear';
import { setModelRoom } from '../ai/modelHost';
import { CloudMilo, aiEndpoint, cloudTts, CreditsError } from '../ai/cloud';
import { adaptSenders, deviceClass, pressureLevel } from '../media/adapt';
import { paidEntitled, invalidateTier, UsageMeter } from '../tier';
import { BwBroker } from '../media/broker';
import { applyPullHint, type PullRid } from '../media/simulcast';
import { SensoryPipe, type SensoryEvent } from '../ai/sensory';
import { uploadRecording } from '../rec/cloud';
import { IsoRecorder } from '../rec/iso';
import { nativeSpeechEndpoint } from '../native';
import { addPoll, addAgenda, addSection, addTalkTimeStats } from '../notes/facilitate';
import type { SipLeg } from '../media/sip';
import { bytesToHex } from '@noble/hashes/utils.js';
import { noteArtifact } from '../bridge/artifacts';
import {
	addMemories,
	loadMemories,
	forgetPeer,
	wipeRoom,
	memoryBlock,
	parseDistilled,
	DISTILL_PROMPT,
	type MemItem
} from '../ai/memory';
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

/** consent round wait — silent peers are excluded, not waited on forever */
const CONSENT_WAIT_MS = 10_000;
/** language tag on caption-update frames — the configured speech lane's
 *  language (VITE_CIC_SPEECH_LANG); 'auto' when auto-detect is on */
const CAPTION_LANG =
	(import.meta.env as Record<string, string | undefined>).VITE_CIC_SPEECH_LANG ?? 'en';

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
	// XState snapshots are not reactive — getSnapshot() has no $state deps, so
	// a $derived over it would freeze at the initial snapshot forever. Mirror
	// the actor's snapshot into $state via stick.subscribe instead.
	private stickSnap = $state(this.stick.getSnapshot());
	stickHolderId = $derived(this.stickSnap.context.holderId);
	stickState = $derived(this.stickSnap.value);
	stickCtx = $derived(this.stickSnap.context);
	chatLog = $state<{ from: string; text: string; whisper?: boolean; milo?: boolean }[]>([]);
	captions = $state<{ from: string; text: string; final: boolean }[]>([]);
	raisedHands = $state<Set<string>>(new Set());
	consentAsked = $state(false); // someone proposed recording — dialog shown
	consents = $state<Record<string, 'pending' | 'granted' | 'denied'>>({});
	recordingProposer = $state<string | null>(null); // mesh peerId that proposed
	recording = $state(false);
	recordingStartedBy = $state<string | null>(null); // recording-start op author — policy gate for recording-stop
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
	/** peerId → their cloud-SFU session id (hello.sfu), when they publish via SFU */
	peerSfuSessions = $state<Record<string, string>>({});
	/** peerId → the SFU publication trackNames it announced (real names, not guessed) */
	peerSfuTracks = $state<Record<string, string[]>>({});
	private sfuSession = '';
	private sfuTrackNames: string[] = [];
	/** low-power media mode — auto-on for low-class devices, UI can flip it */
	lowPower = $state(deviceClass() === 'low');
	localMedia: LocalMedia | null = null;
	captionsAvailable = $state(false);
	/** latest personal-caption update per mesh peer (prod caption-update shape) */
	captionSections = $state<Record<string, Record<string, unknown>>>({});
	miloState = $state<'off' | 'standby' | 'listening' | 'speaking'>('off');
	miloStopNotice = $state<{ by: string; eventId: string } | null>(null); // last stop-ai (peerId + event)
	/** pool ran dry on a metered AI call — UI shows "top up to continue" */
	creditsOut = $state(false);
	/** sha256(code + ':' + password) — '' means cleared; enforced per-bridge at hello */
	passwordHash = $state('');
	/** sentAt of the password-set op that armed the hash — sessions that
	 *  joined AFTER it are the joiner class (they never gate member hellos);
	 *  sessions joined before are the member class (they do the gating) */
	passwordSetAt = 0;
	/** our own proof hash, set by the bridge from hello.password before join */
	accessHash = '';
	/** peers that failed the access proof — denied by us, excluded from seats */
	deniedPeers = new Set<string>();
	/** identity keys (hello cap[0]) of peers that passed the access gate — a
	 *  member reconnecting with the same key is not re-gated (they may
	 *  legitimately lack cap[2], e.g. joined before the password was set) */
	private memberKeys = new Set<string>();
	/** first-accepted-hello receipt time + caps per peer — a password-set op
	 *  landing AFTER their admission re-gates them (retro-deny), while peers
	 *  admitted before the op's sentAt are the legit pre-password class */
	private peerAdmittedAt = new Map<string, number>();
	private peerHelloCap = new Map<string, readonly (string | undefined)[]>();
	private helloRepliedTo = new Set<string>(); // peers whose hello we already answered
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
	 *  ourselves so every session agrees on the same authority.
	 *  staleAuthorities: peers that missed the heartbeat lease — demoted for
	 *  the rest of the session (a GC-paused keeper must not flap the room) */
	authorityId = $derived(
		authorityOf(
			authorityListOf(this.selfId, this.activePeers, this.waitingSelf).filter(
				(id) => !this.staleAuthorities.has(id)
			)
		)
	);
	private staleAuthorities = $state<Set<string>>(new Set());
	private authBeatAt = new Map<string, number>(); // authorityId → last heartbeat receipt (our clock)
	private lastAuthorityId: string | null = null;
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
		brain?: 'auto' | 'local' | 'cloud';
		roundSummary?: boolean; equityNudge?: boolean; welcome?: boolean;
		// persistent host-anchored memory — sealed journal on the authority's
		// device, recalled every session. On by default once ai is enabled.
		memory?: boolean;
	}>({ name: 'Milo', enabled: false });
	/** per-speaker Milo hearing consent — peerId → ear-set{on}. Milo's context
	 *  only ever contains lines from consenting speakers. */
	miloEars = $state<Record<string, boolean>>({});
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
	private meter: UsageMeter | null = null;
	private stickAlive = true; // leave() stops the actor — late sends on a stopped actor warn
	private sendStick(ev: Parameters<typeof this.stick.send>[0]) {
		if (this.stickAlive) this.stick.send(ev);
	}
	// on-device wllama Milo by default; ensureMilo upgrades to the zero-retention
	// cloud gateway when the room carries a paid entitlement (tier.ts)
	private milo: Milo | CloudMilo = new Milo();
	private paidP: Promise<boolean> | null = null;
	private paid(): Promise<boolean> {
		return (this.paidP ??= paidEntitled(this.roomCode));
	}
	/** drop the memo — pool state changed (exhaustion or a fresh top-up) */
	private repaid() {
		this.paidP = null;
		invalidateTier(this.roomCode);
	}
	private tts = new LocalTts();
	private ttsReady: boolean | null = null;
	private transcriptWindow: string[] = [];
	/** Milo's consent-bounded context — only lines from ear-consenting
	 *  speakers, direct addresses, or the room-level sensory lane ever land
	 *  here. transcriptWindow above is broader (recaps/notes). */
	private miloWindow: string[] = [];
	/** dedupe: the same utterance can arrive via captions AND the ear lane */
	private seenMiloLines = new Map<string, number>();
	// ear lane — local mic ASR whose finals go ONLY to the milo-brain seat
	private ear: MicEar | null = null;
	private earFeedUnsub: (() => void) | null = null;
	// Milo's voice is a real pooled mesh track: an AudioContext destination
	// published tagged 'milo' — receivers route him to his own stream/tile
	private miloAudioCtx: AudioContext | null = null;
	private miloDest: MediaStreamAudioDestinationNode | null = null;
	private miloSrc: AudioBufferSourceNode | null = null;
	/** which peer's tagged 'milo' stream currently fills remoteStreams['milo'] */
	private miloStreamFrom: string | null = null;
	private streamTags = new Map<MediaStream, string>(); // published stream → smap tag
	// host-anchored memory: the authority's sealed journal (ai/memory.ts) is
	// the store; the brain keeps the session's recall view here for prompts
	private miloMem: MemItem[] = [];
	private memRecalled = false; // brain seat requests recall once per session
	private linesSinceDistill = 0;
	private lastDistillAt = 0;
	private lastNudgeAt = 0; private lastSummaryAt = 0; private welcomed = new Set<string>();
	private publishedStreams = new Set<MediaStream>();
	/** beyond-GCC: RTT-gradient pre-emption bumps this before adaptMedia reads it */
	private preemptBoost = 0;
	private sipLeg: SipLeg | null = null;
	private broker!: BwBroker;

	constructor(
		public roomSecret: string,
		public displayName: string,
		public roomCode: string
	) {
		this.identity = createIdentity('');
		this.handle = openRoom(roomSecret, { roomCode: this.roomCode });
		setModelRoom(this.roomCode); // metered model proxies carry the room code
		this.e2ee = new E2EESession(this.handle);
		this.recorder = new Recorder(roomCode);
		this.notes = new NotesDoc(this.handle);
		this.oplog = new OpLog(this.identity, (env) =>
			denyReasons(env.op, this.actorFor(env.senderId), this.stateSnapshot())
		);
		this.stick.start();
		// talk-time equity: accumulate holder wall-time from stick snapshots —
		// feeds /talktime → the notes doc's Talk time section
		let heldSince: { id: string | null; at: number } = { id: null, at: 0 };
		this.stick.subscribe((snap) => {
			this.stickSnap = snap; // reactive mirror — $derived views follow
			const id = snap.context.holderId ?? null;
			if (heldSince.id && heldSince.id !== id)
				this.talkMs.set(
					heldSince.id,
					(this.talkMs.get(heldSince.id) ?? 0) + (Date.now() - heldSince.at)
				);
			if (heldSince.id !== id) {
				this.miloHolderChange(heldSince.id, id, snap.context);
				heldSince = { id, at: Date.now() };
				this.pullHintAll(); // witnesses re-pin video to the new stage
			}
		});
		this.broker = new BwBroker(
			this.handle,
			this.selfId,
			() => this.roles?.['bw-allocator'] === this.selfId,
			() => {
				this.preemptBoost++;
				this.adaptMedia();
			}
		);
		this.broker.start();
		// PSTN leg — env-gated, lazy-loaded (sip.js stays out of the bundle
		// unless a trunk is configured); a call lands as a publish stream
		const env = import.meta.env as Record<string, string | undefined>;
		if (env.VITE_CIC_SIP_URI && env.VITE_CIC_SIP_WS) {
			void import('../media/sip').then(({ SipLeg }) => {
				this.sipLeg = new SipLeg((s) => this.publishLocal(s));
				void this.sipLeg!.start().catch(() => (this.sipLeg = null));
			});
		}
		this.policyReady = initPolicy();
		(globalThis as { __room?: RoomHandle }).__room = this.handle; // e2e/debug handle

		this.handle.onPeerJoin((peerId) => {
			if (!this.peers.includes(peerId)) this.peers = [...this.peers, peerId];
			this.joinedAt[peerId] = Date.now();
			this.handle.sendRealtime(this.helloMsg(), peerId); // targeted hello so the joiner gets our keys
			// ...which can still race the DC open on trystero lanes (their sends
			// drop silently when closed) — re-announce until their hello proves
			// the channel live, bounded so a left peer stops the loop
			const retryHello = (n: number) => setTimeout(() => {
				if (!this.peers.includes(peerId) || this.helloRepliedTo.has(peerId)) return;
				this.handle.sendRealtime(this.helloMsg(), peerId);
				if (n > 0) retryHello(n - 1);
			}, 1500);
			retryHello(2);
			// mute state only travels on transitions — a late joiner never saw
			// ours, so default-unmuted reporting makes prod's stall monitor read
			// a locally-muted (silent) track as a transport stall and rejoin
			this.handle.sendRealtime({ t: 'muted', audio: this.selfMuted, video: this.videoMuted }, peerId);
			// tr-lang is declared once at subscribe time — a late joiner never
			// saw it, so a joiner who becomes a caption source wouldn't know
			// who subscribes to which languages. Re-announce like muted state.
			if (this.selfLangs.length)
				this.handle.sendRealtime({ t: 'tr-lang', lang: this.selfLang, langs: this.selfLangs }, peerId);
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
			// our published streams to late joiners or they never see our media.
			// Password rooms hold the offer until the peer's hello verifies —
			// an unverified joiner must never receive member media, even for
			// the ~1s window between pc-connect and hello denial.
			if (!this.passwordHash)
				for (const stream of this.publishedStreams) this.offerStream(stream, peerId);
			this.pullHintAll();
			this.syncSeats();
		});
		this.handle.onPeerLeave((peerId) => {
			this.peers = this.peers.filter((p) => p !== peerId);
			this.waiting = this.waiting.filter((w) => w.id !== peerId);
			this.heldLocal.delete(peerId);
			this.helloRepliedTo.delete(peerId);
			this.peerAdmittedAt.delete(peerId);
			this.peerHelloCap.delete(peerId);
			this.seatedPeers.delete(peerId);
			this.streamOffers.delete(peerId);
			this.peerAway.delete(peerId);
			this.peerSharing.delete(peerId);
			this.peerMuted = { ...this.peerMuted, [peerId]: undefined as never };
			delete this.peerMuted[peerId];
			this.peerConns.delete(peerId);
			this.badPeers = [...this.peerConns.values()].filter(
				(s) => s === 'failed' || s === 'disconnected'
			).length;
			delete this.remoteStreams[peerId];
			delete this.peerSfuSessions[peerId];
			delete this.peerSfuTracks[peerId];
			delete this.peerLangs[peerId];
			this.notifyTrTargets();
			delete this.caps[peerId];
			this.syncReplyAt.delete(peerId);
			this.authBeatAt.delete(peerId);
			dropPeerKey(peerId);
			this.syncSeats();
			void this.rotateKeys('leave', peerId); // FS: departed peer can't read new frames
			this.sendStick({ type: 'HOLDER_LOST' }); // orphan rule: departed holder can't keep the stick
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
			//
			// A peer publishes audio and video as SEPARATE streams (one
			// addStream call each) — naive assignment would let the video
			// stream clobber the audio one. Merge into a per-peer union so
			// remoteStreams[peerId] carries every live track the peer sent.
			const prev = this.remoteStreams[peerId];
			if (prev && prev.id === stream.id &&
				sameTrackIds(prev.getTracks(), stream.getTracks())) return;
			const kept = prev
				? prev.getTracks().filter((t) => t.readyState === 'live' && !stream.getTracks().some((n) => n.kind === t.kind))
				: [];
			const merged = new MediaStream([...kept, ...stream.getTracks()]);
			if (prev && sameTrackIds(prev.getTracks(), merged.getTracks())) return;
			console.debug('[engine] remote stream', peerId, stream.getTracks().map((t) => t.kind).join('+'));
			this.remoteStreams[peerId] = merged;
		});
		// tagged slots (e.g. 'milo') land on their own stream — receivers route
		// Milo to his own tile/audio element instead of the voice seat's mix
		this.handle.onPeerTaggedStream?.((stream, peerId, tag) => {
			if (tag !== 'milo') return;
			this.miloStreamFrom = peerId;
			this.remoteStreams = { ...this.remoteStreams, milo: stream };
		});
		this.handle.onRealtime((msg, peerId) => this.onRealtime(msg, peerId));
		// ops arriving before the policy wasm loads are queued, not denied
		this.handle.onOp((env, peerId) => void this.policyReady.then(() => this.onOp(env, peerId)));

		// connectivity surfaces — the badge overlay reads these $state fields:
		// signalDown = every lane failed (fatal), busDown = ws bus cycling
		// its reconnect loop, badPeers = count of pcs in failed/disconnected
		// (ICE repair retries in the background — the pill explains the wait)
		this.handle.onSignal((st) => (this.signalState = st));
		this.handle.onBus((st) => (this.busDown = st === 'down'));
		this.handle.onPeerConn((peerId, st) => {
			this.peerConns.set(peerId, st);
			this.badPeers = [...this.peerConns.values()].filter(
				(s) => s === 'failed' || s === 'disconnected'
			).length;
		});

		// on-device model loads (100–270MB first touch): busy → "preparing"
		// pill with live download %, error → persistent "degraded" note
		onModel((id, phase, detail) => {
			if (phase === 'loading' && !this.modelBusy.includes(id))
				this.modelBusy = [...this.modelBusy, id];
			if (phase !== 'loading') {
				this.modelBusy = this.modelBusy.filter((p) => p !== id);
				const next = { ...this.modelProgress };
				delete next[id];
				this.modelProgress = next;
			}
			if (phase === 'loading' && detail)
				this.modelProgress = { ...this.modelProgress, [id]: detail };
			if (phase === 'error' && !this.modelFailed.includes(id))
				this.modelFailed = [...this.modelFailed, id];
		});

		// authority heartbeat — lease renewal; missed 2x -> takeover via authorityOf()
		this.heartbeat = window.setInterval(() => {
			// lease watchdog: an authority that misses two beats is demoted
			// (peer-leave is the fast path; this catches the frozen-tab case
			// where the mesh still reports the peer connected)
			const auth = this.authorityId;
			if (auth && auth !== this.selfId && !this.staleAuthorities.has(auth)) {
				const lastBeat = this.authBeatAt.get(auth) ?? Date.now();
				if (Date.now() - lastBeat > LEASE_MS * 2)
					this.staleAuthorities = new Set([...this.staleAuthorities, auth]);
			}
			if (auth !== this.lastAuthorityId) {
				// takeover: the new authority opens a fresh epoch and replays the
				// signed log so peers adopt the regime (applyReplay is
				// epoch-tolerant; late receivers converge identically)
				if (auth === this.selfId && this.lastAuthorityId !== null) {
					this.oplog.advanceEpoch();
					this.handle.sendRealtime({ t: 'op-sync', ops: [...this.oplog.entries] });
					this.handle.sendRealtime({ t: 'authority-heartbeat', leaseUntil: Date.now() + LEASE_MS });
				}
				this.lastAuthorityId = auth;
			}
			if (this.authorityId === this.selfId) {
				this.handle.sendRealtime({ t: 'authority-heartbeat', leaseUntil: Date.now() + LEASE_MS });
			}
			// metered spend: active paid lanes accrue pool-seconds each tick —
			// at zero the entitlement flips and lanes fall back to device
			const laneSecs = (this.sfuSession ? LEASE_MS / 2000 : 0) +
				(this.sensory ? LEASE_MS / 2000 : 0) +
				(this.edgeProcessed ? LEASE_MS / 2000 : 0);
			if (laneSecs) this.meter?.tickSeconds(laneSecs);
			this.adaptMedia();
		}, LEASE_MS / 2);
		this.meter = new UsageMeter(roomCode, () => this.onPoolEmpty());
		this.meter.start();
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
			seats: Object.fromEntries(this.stickCtx.seats.map((id, i) => [String(i), id])),
			occupants: Object.fromEntries(
				[this.selfId, ...this.activePeers].map((id) => [
					id,
					{
						name: this.names[id] ?? '',
						raisedHand: this.raisedHands.has(id),
						// peers join muted; absent a muted frame, assume muted — the
						// safer claim is never "they may speak" without evidence
						selfMuted: id === this.selfId ? this.selfMuted : (this.peerMuted[id]?.audio ?? true),
						autoMuted: false,
						remotelyMuted: id === this.selfId && this.remoteMutedBy.audio === 'audio',
						joinedAtOp: '',
						recordingConsent: this.consents[id] ?? 'pending'
					}
				])
			),
			stick: {
				state: this.stickState === 'held' ? 'held' : 'on_table',
				holderId: this.stickHolderId, atSeatOf: this.stickCtx.atSeatOf,
				resumeTo: this.stickCtx.resumeTo, questionActive: this.stickState === 'question'
			},
			recording: { active: this.recording, startedBy: this.recordingStartedBy, consentRequired: true },
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
			joinedAfterPassword: this.passwordSetAt > 0 && this.joinedAtMs > this.passwordSetAt,
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
			selfLang: this.selfLang, selfLangs: this.selfLangs, peerLangs: this.peerLangs,
			recording: this.recording, recordingStartedBy: this.recordingStartedBy,
			isoRunning: !!this.iso?.running,
			consent: this.consents[this.selfId] ?? null,
			consents: { ...this.consents },
			epoch: this.oplog.epoch, opCount: this.oplog.entries.length,
			stick: {
				state: this.stickState,
				holder: this.stickCtx.holderId,
				atSeatOf: this.stickCtx.atSeatOf,
				resumeTo: this.stickCtx.resumeTo
			},
			mode: this.mode, direction: this.direction, heartMode: this.heartMode,
			streamHls: this.streamHls, streamKeys: Object.keys(this.remoteStreams),
			captions: this.captions.map((c) => `${c.from}:${c.text}`),
			chatLog: this.chatLog.map((c) => `${c.from}:${c.text}`),
			selfMuted: this.selfMuted, peerMuted: { ...this.peerMuted },
			talkMs: Object.fromEntries(this.talkMs),
			media: {
				local:
					(this.localMedia?.stream ?? localFeed())?.getTracks().map((t) => `${t.kind}:${t.readyState}`) ??
					[],
				remote: Object.fromEntries(
					Object.entries(this.remoteStreams).map(([p, s]) => [
						p,
						s.getTracks().map((t) => `${t.kind}:${t.readyState}`)
					])
				)
			}
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
			this.handle.addStream(stream, [peerId], this.streamTags.get(stream));
			offered.add(stream.id);
		} catch { /* track already negotiated — trystero throws instead of no-op */ }
	}

	private syncSeats() {
		const seats = seatedIdsOf(this.selfId, this.peers, this.gateView());
		for (const p of seats) this.seatedPeers.add(p); // self too — seated self can't be re-waitlisted by a stale lobby-waiting list
		this.sendStick({ type: 'SEATS_SET', seats });
		this.roles = electAll(Object.values(this.caps));
		this.broker.setRoleHolder(this.roles['bw-allocator'] ?? null);
		this.retryAuthOps();
		// milo brain is elected now, but the ~100MB GGUF loads lazily on first address
		if (this.roles?.['milo-brain'] === this.selfId && this.miloState === 'off') this.miloState = 'standby';
		if (this.roles?.['milo-brain'] === this.selfId) this.requestMemRecall();
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
		return {
			t: 'hello',
			name: this.displayName,
			cap,
			...(this.sfuSession
				? {
						sfu: this.sfuTrackNames.length
							? { session: this.sfuSession, tracks: this.sfuTrackNames }
							: this.sfuSession
					}
				: {})
		};
	}

	/** capability auction input — broadcast on join, re-announced per-peer
	 *  when a hello proves that DC live (first announce races late joiners) */
	private announceCaps(to?: string) {
		const cap = this.caps[this.selfId];
		if (!cap) return;
		const { peerId: _id, ...body } = cap;
		this.handle.sendRealtime({ t: 'capability', ...body }, to);
	}

	/** cloud-SFU publish path got its session id — re-announce so peers can pull */
	announceSfu(sessionId: string, trackNames: string[] = []) {
		const changed =
			this.sfuSession !== sessionId ||
			trackNames.join(',') !== this.sfuTrackNames.join(',');
		if (!changed) return;
		this.sfuSession = sessionId;
		this.sfuTrackNames = trackNames;
		this.handle.sendRealtime(this.helloMsg());
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
					if (this.canManage(this.selfId)) {
						// the joiner's hello proves their→our channel but ours→them
						// may still be opening — the single send drops silently and
						// they never see the password prompt. Bounded resend until
						// they verify or leave.
						const deny = (n: number) => {
							if (!this.deniedPeers.has(peerId) || !this.peers.includes(peerId)) return;
							this.handle.sendRealtime({ t: 'access-denied' }, peerId);
							if (n > 0) setTimeout(() => deny(n - 1), 1500);
						};
						deny(3);
					}
					break;
				}
				this.deniedPeers.delete(peerId);
				// their hello proves this action channel is live — our own
				// join-time/onPeerJoin hello raced the DC open and may have
				// dropped silently, leaving them unable to name or gate us
				// (password rooms: an undelivered joiner hello = unverified
				// member). Reply once per peer; processing is idempotent.
				if (!this.helloRepliedTo.has(peerId)) {
					this.helloRepliedTo.add(peerId);
					this.handle.sendRealtime(this.helloMsg(), peerId);
				}
				if (msg.sfu) {
					const sfu = typeof msg.sfu === 'string' ? msg.sfu : msg.sfu.session;
					this.peerSfuSessions = { ...this.peerSfuSessions, [peerId]: sfu };
					if (typeof msg.sfu !== 'string')
						this.peerSfuTracks = { ...this.peerSfuTracks, [peerId]: msg.sfu.tracks };
				}
				if (msg.cap[0]) this.memberKeys.add(msg.cap[0]);
				if (!this.peerAdmittedAt.has(peerId)) {
					this.peerAdmittedAt.set(peerId, Date.now());
					this.peerHelloCap.set(peerId, msg.cap);
				}
				this.names[peerId] = msg.name;
				// opt-in welcome — fires once per peer, only once we know the name
				this.maybeWelcome(peerId);
				// a verified hello releases the media held back at join —
				// denied hellos break above before this point
				for (const stream of this.publishedStreams) this.offerStream(stream, peerId);
				// a hello proves the joiner's data channel is live — the
				// onPeerJoin op-sync can fire before it opens, so replay again
				// (opId dedupe makes this a no-op when the first send landed)
				if (this.oplog.entries.length)
					this.handle.sendRealtime({ t: 'op-sync', ops: [...this.oplog.entries] }, peerId);
				// same race as op-sync: the onPeerJoin muted announce can beat
				// the DC open — re-send now that hello proves it live
				this.handle.sendRealtime({ t: 'muted', audio: this.selfMuted, video: this.videoMuted }, peerId);
				if (this.selfLangs.length)
					this.handle.sendRealtime({ t: 'tr-lang', lang: this.selfLang, langs: this.selfLangs }, peerId);
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
				this.pullHintAll();
				// our first capability broadcast raced this peer's DC — hello
				// proves it live now, so re-announce (idempotent, zod-shaped)
				this.announceCaps(peerId);
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
			case 'authority-heartbeat':
				this.authBeatAt.set(peerId, Date.now());
				break;
			case 'op-sync': {
				// member replayed its signed op-log — each envelope re-verifies
				// signature + policy; epoch fencing follows the replayed history.
				// If the log lands at a higher epoch while we still believed
				// ourselves authority, our regime was demoted while we were
				// absent — accept it (self-demote) instead of fighting the fork.
				const wasAuthority = this.authorityId === this.selfId;
				const prevEpoch = this.oplog.epoch;
				void this.policyReady.then(() => {
					for (const env of msg.ops) this.onOp(env, peerId, true);
					if (wasAuthority && this.oplog.epoch > prevEpoch && !this.staleAuthorities.has(this.selfId))
						this.staleAuthorities = new Set([...this.staleAuthorities, this.selfId]);
				});
				break;
			}
			case 'chat':
				this.chatLog = [...this.chatLog, { from: peerId, text: msg.text, whisper: !!msg.whisperTo }];
				break;
			case 'caption-update':
				// while recording, a non-consenting peer's speech is excluded
				// from transcript context — their captions may render live
				// (their own client suppresses them anyway) but never reach
				// Milo, recaps, or persisted transcript artifacts
				this.captions = [...this.captions.slice(-50), { from: peerId, text: msg.text, final: msg.final }];
				if (msg.final && (!this.recording || this.isConsented(peerId)))
					void this.maybeMilo(msg.text, peerId, msg.lang);
				break;
			case 'caption-sections':
				// personal-caption lane sections from a remote source — forwarded to
				// the prod client as caption-update frames (separate from transcript)
				this.captionSections = { ...this.captionSections, [peerId]: msg.update };
				break;
			case 'milo-state':
				this.miloState = msg.state;
				break;
			case 'milo-hear':
				// ear lane — a consenting peer's own-ASR final. Brain seat only;
				// double-check the sender's consent op landed (defense in depth)
				// and heartMode deafens regardless.
				if (this.roles?.['milo-brain'] !== this.selfId || this.heartMode) break;
				if (!this.miloEars[peerId]) break;
				if (this.recording && !this.isConsented(peerId)) break;
				this.ingestMiloLine(peerId, msg.text, msg.lang);
				break;
			case 'milo-mem':
				this.onMiloMem(peerId, msg);
				break;
			case 'hand-raise':
				this.raisedHands = new Set([...this.raisedHands, peerId]);
				break;
			case 'hand-lower':
				this.raisedHands.delete(peerId);
				this.raisedHands = new Set(this.raisedHands);
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
				this.onPeerAway?.(peerId, !!msg.on);
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
				// addressing Milo directly is implicit consent for that one line
				if (msg.text) void this.maybeMilo(`milo ${msg.text}`, peerId);
				else void this.maybeMilo('milo check in', peerId);
				break;
			case 'reaction-kind':
				this.onReaction?.(msg.kind, peerId, this.names[peerId] ?? 'Peer');
				break;
			case 'bw-stats':
				// live link estimate feeds the auction too — a peer whose uplink
				// collapses shouldn't stay forwarder/bw-allocator/recorder
				if (this.caps[peerId]) this.caps[peerId].uplinkKbps = msg.estKbps;
			case 'bw-budget':
				this.broker.handle(msg, peerId);
				break;
			case 'capability':
				this.caps[peerId] = { ...msg, peerId };
				this.syncSeats(); // converged auction input → re-elect
				break;
			case 'pull-hint':
				// the receiver picks which of OUR simulcast layers it wants —
				// apply only on the pc toward that peer (per-receiver selection)
				{
					const pc = this.handle.raw.getPeers()[peerId];
					if (pc) applyPullHint(pc, msg.rid);
				}
				break;
			case 'stream-manifest':
				// webinar fanout live — witnesses beyond mesh scale play HLS
				this.streamHls = msg.hls;
				if (msg.hls) void this.attachStreamHls(msg.hls);
				else this.detachStreamHls();
				break;
			case 'rec-manifest':
				// a peer's ISO recorder announced a sealed segment — collect for
				// the multi-track assembly index (host-side recordings list)
				this.recManifests = [
					...this.recManifests.filter((m) => !(m.peer === peerId && m.rec === msg.rec && m.seg === msg.seg)),
					{ peer: peerId, rec: msg.rec, seg: msg.seg, durationMs: msg.durationMs, bytes: msg.bytes, ts: msg.ts }
				];
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
				this.notifyTrTargets();
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
					// composite filter follows consent live — a mid-record denial
					// drops the peer's tile + mixed audio on the next frame
					if (this.recording) this.recorder.setConsented(this.consentedPeers);
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
	private syncReplyAt = new Map<string, number>(); // peerId → last heal-op-sync sent (rate limit)

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
			// stale-epoch ops mean the sender lags a regime change (missed the
			// takeover op-sync) — heal them by replaying our log, rate-limited
			else if (denies.every((d) => d.startsWith('stale epoch'))) {
				const last = this.syncReplyAt.get(_peerId) ?? 0;
				if (Date.now() - last > 10_000) {
					this.syncReplyAt.set(_peerId, Date.now());
					this.handle.sendRealtime({ t: 'op-sync', ops: [...this.oplog.entries] }, _peerId);
				}
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
			case 'stick-request':
				// question:true opens a question moment (floor loan to the
				// asker, stick stays reserved for the holder); otherwise it's
				// the normal take-the-stick request
				this.sendStick(env.op.question
					? { type: 'QUESTION_ASK', by: env.senderId, to: this.stickCtx.holderId ?? '' }
					: { type: 'REQUEST', by: env.senderId });
				break;
			case 'stick-pass':
				this.sendStick({ type: 'PASS' });
				// circle_round parks in `offered` pending GRANT — pass is a
				// direct transfer (decline path is place-down), so grant the
				// destination seat immediately; every client applies the same
				// op→event sequence and converges identically
				if (this.stick.getSnapshot().value === 'offered')
					this.sendStick({ type: 'GRANT', to: this.stick.getSnapshot().context.resumeTo ?? '' });
				break;
			case 'stick-grant': this.sendStick({ type: 'GRANT', to: env.op.to }); break;
			case 'stick-give': this.sendStick({ type: 'GIVE', to: env.op.to }); break;
			case 'stick-table': this.sendStick({ type: 'TABLE' }); break;
			case 'stick-resume': this.sendStick({ type: 'QUESTION_END' }); break;
			case 'mode-set': this.mode = env.op.mode; this.sendStick({ type: 'MODE_SET', mode: env.op.mode }); break;
			case 'direction-set': this.direction = env.op.direction; this.sendStick({ type: 'DIRECTION_SET', direction: env.op.direction }); break;
			case 'heart-set':
				this.heartMode = env.op.on;
				// invariant: heart-sharing forces recording + transcription off —
				// and deafens Milo's ear lane on this device entirely
				if (env.op.on) {
					if (this.recording) { this.recording = false; void this.finishRecording(); }
					this.captionsAvailable = false;
				}
				this.refreshEar();
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
				const wasEnabled = this.ai.enabled;
				this.ai = { ...this.ai, ...patch };
				// enabled flips Milo's whole surface: the ear lane, the state
				// badge, and the brain's willingness to generate
				if (patch.enabled !== undefined) this.refreshEar();
				if ((patch.memory === true || patch.enabled === true) && this.roles?.['milo-brain'] === this.selfId)
					this.requestMemRecall();
				if (patch.enabled === false && wasEnabled !== false) {
					this.milo.interrupt();
					this.miloState = 'off';
				} else if (patch.enabled === true && this.roles?.['milo-brain'] === this.selfId && this.miloState === 'off') {
					this.miloState = 'standby';
				}
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
				if (p.questionMoments !== undefined)
					this.sendStick({ type: 'QUESTION_MOMENTS_SET', on: p.questionMoments });
				if (p.recording === false && this.recording) { this.recording = false; void this.finishRecording(); }
				break;
			}
			case 'recording-start': this.recording = true; this.recordingStartedBy = env.senderId; this.consentAsked = false; void this.maybeRecord(); this.refreshEar(); break;
			case 'consent':
				// self-attributed: the op is signed by senderId — consent can
				// never be forged for another participant. Mirror the realtime
				// path so the op-log alone (op-sync replay) reproduces the
				// same start/exclusion decisions.
				if (env.op.kind === 'recording') {
					this.consents[env.senderId] = env.op.state;
					if (this.recording) this.recorder.setConsented(this.consentedPeers);
					this.maybeStartRecording();
					// a self-exclusion flip changes whether OUR ear may hear us
					if (env.senderId === this.selfId) this.refreshEar();
				}
				break;
			case 'ear-set':
				// self-attributed Milo-hearing consent — same self-attribution
				// guarantee as consent: only the signer's own flag flips
				this.miloEars = { ...this.miloEars, [env.senderId]: env.op.on };
				if (env.senderId === this.selfId) this.refreshEar();
				break;
			case 'erasure': {
				// self: purge own contributions; participant: authority purges
				// target's. Consent removal also excludes them from any active
				// record going forward (already-sealed segments are ciphertext
				// blobs addressed to the host — out of this op's reach).
				const target = env.op.scope === 'self' ? env.senderId : env.op.target;
				this.purgeContributions(target);
				// Milo's journal too — the memory host purges items attributed
				// to (or naming) the erased peer; a no-op on every other device
				void forgetPeer(this.roomCode, this.roomSecret, target, this.names[target]);
				this.miloMem = this.miloMem.filter((m) => m.by !== target);
				break;
			}
			case 'recording-stop':
				this.recording = false;
				this.recordingStartedBy = null;
				this.consents = {};
				this.consentAsked = false;
				this.recordingProposer = null;
				void this.finishRecording();
				this.refreshEar(); // exclusion lifted — a consenting ear re-opens
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
			case 'password-set': {
				this.passwordHash = env.op.hash;
				this.passwordSetAt = env.op.hash ? env.sentAt : 0;
				// hellos raced the op broadcast: peers admitted in the window
				// [op.sentAt, local apply] never proved against the now-set hash.
				// Re-gate them — cap[2] matching the new hash proves retroactively,
				// the rest must leave and retry (memberKeys purged so their
				// identity key can't dodge the gate on rejoin). Peers admitted
				// before sentAt are the pre-password member class — exempt.
				if (env.op.hash) {
					for (const pid of this.peers) {
						const admittedAt = this.peerAdmittedAt.get(pid);
						if (admittedAt === undefined || admittedAt <= env.sentAt) continue;
						const cap = this.peerHelloCap.get(pid);
						if (cap?.[2] === env.op.hash) continue;
						this.deniedPeers.add(pid);
						if (cap?.[0]) this.memberKeys.delete(cap[0]);
						if (this.canManage(this.selfId)) {
							const deny = (n: number) => {
								if (!this.deniedPeers.has(pid) || !this.peers.includes(pid)) return;
								this.handle.sendRealtime({ t: 'access-denied' }, pid);
								if (n > 0) setTimeout(() => deny(n - 1), 1500);
							};
							deny(3);
						}
					}
				}
				break;
			}
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
		// media egress gate (all lanes/offer paths): denied + lobby-held peers
		// never receive our streams, password rooms hold every joiner's pulls
		// until their hello verifies cap[2], and a joiner who arrived after the
		// password was set holds her own streams until her proof matches (a
		// member that denies her shouldn't see her camera while she's
		// unverified — her teardown closes the pc, this gates new offers)
		this.handle.offerGate = (peerId) => {
			const joinerUnproven =
				this.passwordSetAt > 0 &&
				this.joinedAtMs > this.passwordSetAt &&
				this.accessHash !== this.passwordHash;
			return (
				!this.deniedPeers.has(peerId) &&
				!this.heldLocal.has(peerId) &&
				!joinerUnproven &&
				(!this.passwordHash || this.helloRepliedTo.has(peerId))
			);
		};
		registerPeerKey(this.selfId, bytesToHex(this.identity.publicKey));
		this.handle.sendRealtime(this.helloMsg());
		this.handle.sendRealtime({ t: 'muted', audio: this.selfMuted, video: this.videoMuted });
		this.caps[this.selfId] = await measureCapability(this.selfId);
		this.announceCaps();
		this.syncSeats();
	}

	/** hook for the bridge: SFU pull-side clamp under pressure (tracks/update) */
	onPressureLevel: ((level: number) => void) | null = null;

	/** hook for the bridge: away peers → video pull drops to a trickle */
	onPeerAway: ((peerId: string, away: boolean) => void) | null = null;

	/** last computed pressure level 0–3 — drives the quality badge */
	pressure = $state(0);

	/** signaling-plane health — 'down' means every lane failed (badge shows fatal) */
	signalState = $state<'connecting' | 'up' | 'down'>('connecting');
	/** ws signaling bus cycling its reconnect loop — transient, badge shows amber */
	busDown = $state(false);
	/** peers whose ICE is failed/disconnected — repair is retrying underneath */
	badPeers = $state(0);
	private peerConns = new Map<string, string>();
	/** on-device model packs currently downloading/initializing */
	modelBusy = $state<string[]>([]);
	/** per-model download detail (pct/sizeHint) for the busy pill */
	modelProgress = $state<Record<string, { pct?: number; sizeHint?: string }>>({});
	/** model packs that failed to load — their features degrade visibly */
	modelFailed = $state<string[]>([]);

	/** adaptive media pressure → per-sender bitrate/resolution clamps */
	private adaptMedia() {
		let worst = 'connected';
		for (const p of this.peers) {
			const st = this.handle.peerConnState(p);
			if (st === 'failed' || st === 'disconnected') worst = st;
			else if (st !== 'connected' && st !== 'completed' && worst === 'connected') worst = st;
		}
		const level = Math.min(3,
			pressureLevel({ peerCount: this.peers.length, worstConn: worst, batterySaver: this.lowPower }) +
				this.preemptBoost // beyond-GCC: RTT-gradient pre-emption bumps before loss
		);
		this.pressure = level;
		this.onPressureLevel?.(level);
		if (!this.publishedStreams.size) return;
		adaptSenders(this.handle, level);
	}

	/** witness/audience mode — receive-only: we pull, never publish */
	witnessOnly = $state(false);
	/** producer crew — witness + never ISO-recorded + monitors every seat */
	producerOnly = $state(false);
	private iso: IsoRecorder | null = null;

	/**
	 * Webinar-lite pull hints: a witness subscribes audio-everything +
	 * video only from the stage (stick holder / fallback: authority);
	 * a producer gets every seat at half-res for monitoring. Senders honor
	 * hints per-pc via simulcast rid activation — audience bandwidth scales
	 * to ~1 video leg regardless of seat count.
	 */
	private pullHintAll() {
		if (!this.witnessOnly) return;
		const stage = this.stickHolderId ?? this.authorityId;
		for (const p of this.peers)
			if (p !== this.selfId)
				this.handle.sendRealtime(
					{ t: 'pull-hint', rid: this.producerOnly ? 'h' : p === stage ? 'f' : 'none' },
					p
				);
	}

	/** explicit pull hint toward one peer (e.g. focus-pin a seat's video) */
	pullHint(peerId: string, rid: PullRid) {
		this.handle.sendRealtime({ t: 'pull-hint', rid }, peerId);
	}

	/** ISO segments announced by peers — multi-track recording index */
	recManifests = $state<{ peer: string; rec: string; seg: number; durationMs: number; bytes: number; ts: number }[]>([]);

	/** webinar fanout — set when the authority broadcasts a CF Stream HLS manifest */
	streamHls = $state<string | null>(null);
	private streamHlsStop: (() => void) | null = null;
	private streamVideo: HTMLVideoElement | null = null;

	/** host announces a live HLS manifest (Cloudflare Stream) to witnesses */
	announceStream(hls: string) {
		if (!this.canManage(this.selfId)) return;
		this.streamHls = hls;
		void this.attachStreamHls(hls);
		this.handle.sendRealtime({ t: 'stream-manifest', hls });
	}

	/**
	 * Witness-side HLS playback: play the manifest into a hidden video and
	 * surface its captureStream() as a `live-stream` remote stream — the
	 * bridge emits it as a synthetic participant, so the vendored UI renders
	 * the live feed in a normal seat tile with zero DOM surgery.
	 */
	private async attachStreamHls(hls: string) {
		this.detachStreamHls();
		const video = document.createElement('video');
		video.playsInline = true;
		const { attachHls } = await import('../media/hlsPlay');
		this.streamHlsStop = await attachHls(video, hls);
		this.streamVideo = video;
		const cap = (video as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream });
		const stream = cap.captureStream?.() ?? cap.mozCaptureStream?.();
		if (stream) this.remoteStreams = { ...this.remoteStreams, 'live-stream': stream };
	}

	private detachStreamHls() {
		this.streamHlsStop?.();
		this.streamHlsStop = null;
		this.streamVideo = null;
		if (this.remoteStreams['live-stream']) {
			const next = { ...this.remoteStreams };
			delete next['live-stream'];
			this.remoteStreams = next;
		}
	}

	/** opt-in media enhancements (enhance.ts): all default-off, fail-open */
	mediaFx = $state({
		denoise: false,
		videoFx: 'off' as 'off' | 'blur' | 'image' | 'crop',
		spatial: false,
		music: false
	});

	/** edge-processed audio lane: plaintext audio to cic-dsp — NOT E2EE */
	edgeProcessed = $state(false);
	private fxApplied = new WeakSet<MediaStreamTrack>();

	/** swap each new track for its processed twin when an enhancement is on */
	private async enhanceStream(stream: MediaStream): Promise<MediaStream> {
		const { denoise, videoFx } = this.mediaFx;
		if (!denoise && videoFx === 'off') return stream;
		const { denoiseAudioTrack, videoFxTrack, smartCropTrack } = await import('../media/enhance');
		const out = new MediaStream();
		for (const track of stream.getTracks()) {
			if (this.fxApplied.has(track)) continue;
			this.fxApplied.add(track);
			let next = track;
			if (track.kind === 'audio' && denoise) next = (await denoiseAudioTrack(track))?.track ?? track;
			if (track.kind === 'video' && videoFx === 'crop')
				next = (await smartCropTrack(track))?.track ?? track;
			else if (track.kind === 'video' && videoFx !== 'off' && videoFx !== 'crop')
				next = (await videoFxTrack(track, videoFx))?.track ?? track;
			out.addTrack(next);
		}
		return out.getTracks().length ? out : stream;
	}

	/** track-level dedupe — republishing a track under a new stream wrapper
	 *  (e.g. `new MediaStream([track])` from the SFU ontrack path) must not
	 *  double-add: trystero would throw "sender already exists" */
	private publishedTracks = new Set<MediaStreamTrack>();

	/** production-frontend path: media arrives over the loopback SFU — publish it to the mesh */
	publishLocal(stream: MediaStream) {
		if (this.witnessOnly) return; // audience lane publishes nothing
		void this.enhanceStream(stream).then((s) => {
			const fresh = s.getTracks().filter((t) => !this.publishedTracks.has(t));
			if (!fresh.length) return;
			for (const t of fresh) this.publishedTracks.add(t);
			const out = fresh.length === s.getTracks().length ? s : new MediaStream(fresh);
			this.publishedStreams.add(out);
			this.handle.addStream(out);
			this.breakout?.publish(out);
		});
	}

	/**
	 * Edge denoise lane (paid, explicit opt-in): attach a Cloudflare Realtime
	 * audio Media Transport Adapter pointing at cic-dsp. The mic track reaches
	 * the SFU as PLAINTEXT, gets cleaned at the edge, and republishes — so we
	 * raise edgeProcessed and the UI must show "edge-processed, not E2EE".
	 */
	async enableEdgeDenoise(): Promise<boolean> {
		if (!this.sfuSession || this.edgeProcessed) return this.edgeProcessed;
		if (!(await paidEntitled(this.roomCode))) {
			this.creditsOut = true; // paid lane only — surface the top-up pill
			return false;
		}
		// adapter URL is dialed by the SFU — wants ws(s)://
		const base = (
			(import.meta.env as Record<string, string | undefined>).VITE_CIC_DSP_ENDPOINT ??
			'https://cic-dsp.regenleadership.workers.dev'
		).replace(/^http/, 'ws');
		const res = await fetch(
			`${(import.meta.env as Record<string, string | undefined>).VITE_CIC_SFU_ENDPOINT ?? '/api/sfu'}/sessions/${this.sfuSession}/adapters/new`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					tracks: [
						{
							location: 'local',
							trackName: this.sfuTrackNames.find((n) => n.startsWith('audio')) ?? 'audio',
							adapter: {
								type: 'audio',
								url: `${base}/audio?session=${this.sfuSession}&room=${encodeURIComponent(this.roomCode)}`
							}
						}
					]
				})
			}
		).catch(() => null);
		if (!res?.ok) return false;
		this.edgeProcessed = true; // badge: edge-processed, not E2EE
		return true;
	}

	/**
	 * Sensory lane (paid, opt-in): SpeechStreamPipe tees 16k PCM16 here →
	 * cic-dsp /speech → Speechmatics/AssemblyAI relay → ingestSensory events.
	 * Diarized segments + audio events enrich Milo's context — who spoke and
	 * what the room sounded like, not just words.
	 */
	sensory: SensoryPipe | null = null;

	async enableSensory(): Promise<boolean> {
		if (this.sensory) return true;
		const env = import.meta.env as Record<string, string | undefined>;
		// VITE_CIC_DSP_ENDPOINT is an https origin; WS paths derive ws(s)://
		const dsp = env.VITE_CIC_DSP_ENDPOINT;
		const dspWs = dsp?.replace(/^http/, 'ws');
		// native shell: the in-process speechd endpoint is local — no JWT,
		// no cloud hop, no meter; preferred over any configured remote
		const nativeEp = await nativeSpeechEndpoint();
		if (nativeEp) {
			this.sensory = new SensoryPipe(nativeEp, this, true);
		} else if (!(await paidEntitled(this.roomCode))) {
			// every remaining lane is paid (Speechmatics relay / dsp relay) —
			// fail before minting tokens or opening sockets
			this.creditsOut = true;
			return false;
		} else if (env.VITE_CIC_SPEECH_URL) {
			let url = env.VITE_CIC_SPEECH_URL;
			if (!url.includes('jwt=') && dsp) {
				const tok = await fetch(`${dsp}/speech-token?room=${encodeURIComponent(this.roomCode)}`)
					.then((r) => (r.ok ? (r.json() as Promise<{ key_value?: string }>) : null))
					.catch(() => null);
				if (tok?.key_value) url += `${url.includes('?') ? '&' : '?'}jwt=${tok.key_value}`;
			}
			this.sensory = new SensoryPipe(url, this, true);
		} else if (dspWs) {
			// relay mode: cic-dsp owns provider auth, we ship raw PCM16 —
			// the ?room= query identifies the metered pool (WS can't carry headers)
			this.sensory = new SensoryPipe(`${dspWs}/speech?room=${encodeURIComponent(this.roomCode)}`, this);
		} else {
			return false;
		}
		this.sensory.start();
		this.edgeProcessed = true; // plaintext audio leaves the device — badge it
		return true;
	}

	/** pool hit zero mid-session: paid lanes stop now and the top-up pill
	 *  shows; the P2P call continues on the free floor (mesh + on-device) */
	private onPoolEmpty() {
		this.creditsOut = true;
		this.sensory?.stop();
		this.sensory = null;
		this.edgeProcessed = false;
		this.repaid();
	}

	/** the relay itself reported exhaustion (4402 close) — same handling */
	creditsEmpty() {
		this.onPoolEmpty();
	}

	/** a grant landed on this room — re-arm the meter + clear the exhaustion
	 *  pill so paid lanes are eligible again on the next request */
	markToppedUp() {
		this.creditsOut = false;
		this.meter?.reset();
		this.repaid();
	}

	/** sensory events from the /speech relay: diarized transcript + audio events */
	ingestSensory(ev: SensoryEvent) {
		// excluded participant: our own mic's transcript also stays out of
		// Milo context + recaps while recording is active
		if (this.recording && !this.isConsented(this.selfId)) return;
		if (ev.t === 'transcript' && ev.text) {
			const label = ev.speaker ? `[${ev.speaker}] ${ev.text}` : ev.text;
			this.transcriptWindow = [...this.transcriptWindow.slice(-39), label];
			// the sensory lane IS the speaker's opt-in — enabling it forwards our
			// mic to a cloud ASR; feeding Milo's context here needs no ear-set
			if (ev.final && this.ai.enabled && !this.heartMode &&
				!this.miloLineSeen(this.selfId, ev.text)) {
				this.miloWindow = [...this.miloWindow.slice(-39), label];
				void this.miloTrigger(ev.text);
			}
		} else if (ev.t === 'event' && ev.event && !ev.end) {
			// audio events → room mood signal: transcript context + a reaction op
			this.transcriptWindow = [...this.transcriptWindow.slice(-39), `[room] ${ev.event}`];
			this.handle.sendRealtime({ t: 'reaction-kind', kind: `audio:${ev.event}` });
		}
	}

	/** a caption segment from the speech stream (prod frontend streams PCM via speech-frame) */
	appendCaption(text: string, final: boolean, lang?: string) {
		this.captions = [...this.captions.slice(-50), { from: this.selfId, text, final }];
		// excluded participant (denied/silent while recording): our speech is
		// never broadcast as captions, never stored, never fed to Milo
		const excluded = this.recording && !this.isConsented(this.selfId);
		if (!excluded)
			this.handle.sendRealtime({ t: 'caption-update', text, final, lang: lang ?? CAPTION_LANG });
		if (final && !excluded) {
			this.storeTranscriptLine(this.names[this.selfId] ?? this.displayName, text);
			void this.maybeMilo(text, this.selfId, lang);
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
		if (!this.ai.enabled) { this.miloState = 'off'; return; }
		this.miloInitStarted = true;
		// brain selection: 'local' pins on-device; 'cloud' refuses the local
		// fallback (zero-retention-only rooms); 'auto' = cloud when the room
		// is entitled + a gateway is configured, local otherwise
		const pref = this.ai.brain ?? 'auto';
		const cloud = pref === 'cloud' || (pref === 'auto' && !!aiEndpoint() && (await this.paid()));
		this.milo = cloud ? new CloudMilo(this.roomCode) : new Milo();
		const ok = await this.milo.init({
			modelUrl: await llmModelUrl(),
			maxContextTokens: 2048
		});
		this.miloState = this.milo.state;
		this.milo.onSay = (text) => {
			this.handle.sendRealtime({ t: 'chat', text: `Milo: ${text}` });
			this.chatLog = [...this.chatLog, { from: this.selfId, text: `Milo: ${text}`, milo: true }];
			void this.speakMilo(text);
			this.handle.sendRealtime({ t: 'milo-state', state: this.milo.state });
		};
		this.handle.sendRealtime({ t: 'milo-state', state: this.milo.state });
		void ok;
	}

	/** one brain call — cloud failures fall back to the on-device lane unless
	 *  the room's ai-set pinned brain:'cloud' (zero-retention rooms) */
	private async miloAsk(prompt: string, lang?: string) {
		const opts = { lang, instructions: this.ai.instructions, name: this.ai.name };
		const promptWithMem = this.miloMem.length ? memoryBlock(this.miloMem) + prompt : prompt;
		try {
			const reply = await this.milo.ask(promptWithMem, this.miloWindow, opts);
			if (this.milo instanceof CloudMilo) this.meter?.tickCall(this.milo.lastCallId);
			return reply;
		} catch (e) {
			if (e instanceof CreditsError) { this.creditsOut = true; invalidateTier(this.roomCode); }
			if (this.milo instanceof CloudMilo && (this.ai.brain ?? 'auto') !== 'cloud') {
				console.warn('[milo] cloud brain failed — falling back to on-device', e);
				const local = new Milo();
				local.onSay = this.milo.onSay;
				const ok = await local.init({ modelUrl: await llmModelUrl(), maxContextTokens: 2048 });
				if (ok) { this.milo = local; return local.ask(promptWithMem, this.miloWindow, opts); }
			}
			return '';
		}
	}

	/** normalized dedupe — a consenting speaker's utterance can reach Milo via
	 *  both the ear lane (milo-hear) and broadcast captions; feed it once */
	private miloLineSeen(speakerId: string, text: string): boolean {
		const key = `${speakerId}:${text.trim().toLowerCase().replace(/\s+/g, ' ')}`;
		const now = Date.now();
		for (const [k, at] of this.seenMiloLines) if (now - at > 15_000) this.seenMiloLines.delete(k);
		if (this.seenMiloLines.has(key)) return true;
		this.seenMiloLines.set(key, now);
		return false;
	}

	private miloLabel(speakerId: string, lang?: string): string {
		const name = speakerId === this.selfId
			? (this.names[this.selfId] ?? this.displayName ?? 'me')
			: (this.names[speakerId] ?? 'peer');
		return `[${name}${lang && lang !== 'auto' ? `/${lang}` : ''}]`;
	}

	/** a line enters Milo's context — speakers the ear lane reports get a
	 *  labeled entry; the brain then checks it for a direct address */
	private ingestMiloLine(speakerId: string, text: string, lang?: string) {
		if (!this.ai.enabled || this.heartMode || !text.trim()) return;
		if (this.miloLineSeen(speakerId, text)) return;
		this.miloWindow = [...this.miloWindow.slice(-39), `${this.miloLabel(speakerId, lang)} ${text.trim()}`];
		this.linesSinceDistill++;
		this.maybeDistill();
		void this.miloTrigger(text, lang, speakerId);
	}

	/** direct-address check + generation — runs only on the brain seat and
	 *  only while ai.enabled && !ai.standby && !heartMode */
	private async miloTrigger(raw: string, lang?: string, speakerId?: string) {
		if (!this.ai.enabled || this.ai.standby || this.heartMode) return;
		if (this.roles?.['milo-brain'] !== this.selfId) return;
		const src = raw.trim();
		// click mode: strict "milo, <question>" line start. hey_milo: the wake
		// word anywhere in the utterance also wakes (ASR streams finals here).
		const match =
			src.match(/^milo[\s,.:;-]+(.+)/i) ??
			(this.miloWake === 'hey_milo' ? src.match(/\bhey[,.\s]*milo[\s,.:;-]+(.+)/i) : null);
		if (!match) return;
		this.miloState = 'listening';
		this.handle.sendRealtime({ t: 'milo-state', state: 'listening' });
		await this.ensureMilo();
		const ask = match[1].trim();
		if (await this.miloMemCommand(ask, speakerId ?? this.selfId)) {
			this.miloState = 'standby';
			return;
		}
		await this.miloAsk(ask, lang);
		this.miloState = this.milo.state;
	}

	/** memory verbs addressed at Milo — handled before the brain call so a
	 *  'remember that …' never becomes a question he has to interpret.
	 *  Returns true when the line was a memory command (already acked). */
	private async miloMemCommand(ask: string, speakerId: string): Promise<boolean> {
		const remembered = ask.match(/^(?:please\s+)?remember\s+(?:that\s+)?(.+)/i);
		if (remembered) {
			if (this.memoryOn) {
				this.persistMem([{ text: remembered[1].trim(), by: speakerId }]);
				this.sayAsMilo("Noted — I'll remember that.");
			} else this.sayAsMilo('Memory is off in this room.');
			return true;
		}
		if (/^(?:please\s+)?forget\s+everything/i.test(ask)) {
			if (!this.canManage(speakerId)) {
				this.sayAsMilo('Only a host or co-host can wipe my memory.');
				return true;
			}
			if (this.authorityId === this.selfId) {
				await wipeRoom(this.roomCode);
				this.miloMem = [];
			} else if (this.authorityId) {
				this.handle.sendRealtime({ t: 'milo-mem', wipe: true }, this.authorityId);
				this.miloMem = [];
			}
			this.sayAsMilo('Forgotten — this room starts fresh with me.');
			return true;
		}
		if (/^(?:please\s+)?forget\s+(?:me|what\s+i\s+(?:said|told\s+you))/i.test(ask)) {
			if (this.authorityId === this.selfId)
				await forgetPeer(this.roomCode, this.roomSecret, speakerId, this.names[speakerId]);
			else if (this.authorityId)
				this.handle.sendRealtime({ t: 'milo-mem', forget: speakerId }, this.authorityId);
			this.miloMem = this.miloMem.filter((m) => m.by !== speakerId);
			this.sayAsMilo("Done — I've dropped what I kept from you.");
			return true;
		}
		return false;
	}

	/** a canned line through Milo's normal surface — chat frame + voice
	 *  track — without a brain call (used for memory acks) */
	private sayAsMilo(text: string) {
		this.handle.sendRealtime({ t: 'chat', text: `Milo: ${text}` });
		this.chatLog = [...this.chatLog, { from: this.selfId, text: `Milo: ${text}`, milo: true }];
		void this.speakMilo(text);
	}

	/** caption/chat/sensory ingest — recap context is unconditional; Milo's
	 *  context is consent-bounded (ear-set opt-in, or a direct address is
	 *  implicit consent for that one line) */
	private async maybeMilo(text: string, speakerId?: string, lang?: string) {
		this.transcriptWindow = [...this.transcriptWindow.slice(-39), text];
		if (!this.ai.enabled || this.heartMode) return;
		const sid = speakerId ?? this.selfId;
		const src = text.trim();
		const direct =
			/^milo[\s,.:;-]+/i.test(src) ||
			(this.miloWake === 'hey_milo' && /\bhey[,.\s]*milo[\s,.:;-]+/i.test(src));
		if (this.miloEars[sid] || direct)
			this.ingestMiloLine(sid, src, lang);
	}

	// --- ear lane: consenting speakers' own ASR → the milo-brain seat ---

	/** local user toggles Milo-hearing consent — self-attributed signed op */
	setEar(on: boolean) { this.emitOp({ t: 'ear-set', on }); }

	/** start/stop the mic tap. Milo's ear runs only while: the room enabled AI,
	 *  we signed ear-set{on}, heartMode is off, and we're not a
	 *  recording-excluded participant (their speech must not reach context). */
	private refreshEar() {
		const want = !!(
			this.ai.enabled && this.miloEars[this.selfId] && !this.heartMode &&
			!(this.recording && !this.isConsented(this.selfId))
		);
		if (!want) {
			this.ear?.stop();
			this.ear = null;
			return;
		}
		if (this.ear) return;
		const mic = this.localMedia?.stream ?? localFeed();
		if (!mic) {
			// media not acquired yet — retry when the join-time capture lands
			if (!this.earFeedUnsub)
				this.earFeedUnsub = onLocalFeed(() => {
					this.earFeedUnsub = null;
					this.refreshEar();
				});
			return;
		}
		const ear = new MicEar({ onLine: (text, lang) => this.ownEarLine(text, lang) });
		this.ear = ear;
		void ear.start(mic).then((ok) => { if (!ok && this.ear === ear) this.ear = null; });
	}

	/** our own ASR final — to the brain seat (self: ingest directly, remote:
	 *  a targeted milo-hear realtime frame). Text-only: audio never leaves. */
	private ownEarLine(text: string, lang?: string) {
		if (!this.ai.enabled || this.heartMode) return;
		if (this.recording && !this.isConsented(this.selfId)) return;
		const brain = this.roles?.['milo-brain'];
		if (!brain) return;
		if (brain === this.selfId) this.ingestMiloLine(this.selfId, text, lang);
		else this.handle.sendRealtime({ t: 'milo-hear', text, lang }, brain);
	}

	// --- persistent memory (host-anchored sealed journal, ai/memory.ts) ---

	/** memory lives on the authority's device ("stay with the host") and is
	 *  keyed by room code — every session of the same room link recalls the
	 *  same journal, so Milo thinks across all of that room's conversations */
	private get memoryOn(): boolean {
		return !!this.ai.enabled && this.ai.memory !== false && !this.heartMode;
	}

	/** brain seat pulls the room's journal once per session. Authority holds
	 *  it locally; a remote authority answers a targeted milo-mem{req}. */
	private requestMemRecall() {
		if (!this.memoryOn || this.memRecalled) return;
		this.memRecalled = true;
		if (this.authorityId === this.selfId) {
			void loadMemories(this.roomCode, this.roomSecret).then((items) => {
				if (items.length) this.miloMem = items;
			});
		} else if (this.authorityId) {
			this.handle.sendRealtime({ t: 'milo-mem', req: true }, this.authorityId);
		}
	}

	/** milo-mem handler — the authority is the store; the brain is the
	 *  consumer. Targeted sends only, everything sealed at rest. */
	private onMiloMem(peerId: string, msg: { req?: boolean; recall?: boolean; wipe?: boolean; forget?: string; items?: { text: string; by?: string }[] }) {
		if (msg.recall && msg.items?.length) {
			// authority answered our req — adopt the recall view
			if (peerId === this.authorityId && this.roles?.['milo-brain'] === this.selfId)
				this.miloMem = msg.items;
			return;
		}
		// everything below only the memory host (authority) serves
		if (this.authorityId !== this.selfId) return;
		if (msg.req) {
			void loadMemories(this.roomCode, this.roomSecret).then((items) => {
				if (items.length)
					this.handle.sendRealtime({ t: 'milo-mem', recall: true, items }, peerId);
			});
			return;
		}
		if (msg.wipe) {
			// room wipe must come from a manager (the brain relays commands;
			// the speaker's own seat is what asked)
			if (this.canManage(peerId)) void wipeRoom(this.roomCode).then(() => { this.miloMem = []; });
			return;
		}
		if (msg.forget) {
			void forgetPeer(this.roomCode, this.roomSecret, msg.forget, this.names[msg.forget]);
			return;
		}
		if (msg.items?.length) {
			// brain seat distilled new facts — persist + fold into our recall view
			void addMemories(this.roomCode, this.roomSecret, msg.items).then((n) => {
				if (n) this.miloMem = [...this.miloMem, ...msg.items!].slice(-60);
			});
		}
	}

	/** persist memory items to the journal host — local write when we're
	 *  the authority, targeted milo-mem{items} otherwise */
	private persistMem(items: MemItem[]) {
		if (!this.memoryOn || !items.length) return;
		if (this.authorityId === this.selfId) {
			void addMemories(this.roomCode, this.roomSecret, items).then((n) => {
				if (n) this.miloMem = [...this.miloMem, ...items].slice(-60);
			});
		} else if (this.authorityId) {
			this.handle.sendRealtime({ t: 'milo-mem', items }, this.authorityId);
			this.miloMem = [...this.miloMem, ...items].slice(-60); // brain keeps its own recall view
		}
	}

	/** periodic distill: every ~25 context lines (and ≥2min), the brain
	 *  extracts durable facts from its window and journals them. A distilling
	 *  ask doesn't speak — onSay is bypassed by asking the brain directly. */
	private maybeDistill() {
		if (!this.memoryOn) return;
		if (this.roles?.['milo-brain'] !== this.selfId) return;
		if (this.linesSinceDistill < 25 || Date.now() - this.lastDistillAt < 120_000) return;
		this.lastDistillAt = Date.now();
		this.linesSinceDistill = 0;
		void this.milo.ask(DISTILL_PROMPT, this.miloWindow, { name: this.ai.name })
			.then((reply) => {
				const texts = parseDistilled(reply ?? '');
				if (texts.length) this.persistMem(texts.map((text) => ({ text })));
			})
			.catch(() => {});
	}

	/** Milo facilitation acts — opt-in via ai-set (roundSummary/equityNudge/
	 *  welcome). He never holds the floor: speaks only between turns or when
	 *  the floor is free. Brain seat generates; voice seat speaks. */
	private miloHolderChange(prev: string | null, next: string | null, ctx: { seats: string[]; mode: string; direction: string }) {
		if (!this.ai.enabled || this.ai.standby || this.heartMode) return;
		if (this.roles?.['milo-brain'] !== this.selfId) return;
		const order = ctx.direction === 'sunwise' ? ctx.seats : [...ctx.seats].reverse();
		// circle_round wrap: the stick passed the last seat and came back
		// around — the round completed, summarize if the room opted in
		if (this.ai.roundSummary && ctx.mode === 'circle_round' && prev && next) {
			const pi = order.indexOf(prev), ni = order.indexOf(next);
			if (pi >= 0 && ni >= 0 && ni <= pi && Date.now() - this.lastSummaryAt > 60_000) {
				this.lastSummaryAt = Date.now();
				void this.miloAsk('The circle just completed a full round. Summarize what was shared in one or two sentences.');
			}
		}
		// equity nudge: stick returned to table with skewed talk-time —
		// invite quieter voices, rate-limited so he nudges at most every 5min
		if (this.ai.equityNudge && !next && Date.now() - this.lastNudgeAt > 300_000) {
			const entries = [...this.talkMs.entries()].filter(([, ms]) => ms > 60_000);
			if (entries.length >= 3) {
				const total = entries.reduce((a, [, ms]) => a + ms, 0);
				const [topId, topMs] = entries.sort((a, b) => b[1] - a[1])[0];
				if (topMs / total > 0.6) {
					this.lastNudgeAt = Date.now();
					void this.miloAsk(`Talk time has skewed — ${this.names[topId] ?? 'one voice'} has carried most of the floor. In one sentence, gently invite voices we haven't heard from.`);
				}
			}
		}
	}

	/** welcome a newly seated peer — opt-in (ai-set welcome) and rate-safe:
	 *  each peer is greeted once per session, only when we know their name */
	private maybeWelcome(peerId: string) {
		if (!this.ai.enabled || this.ai.standby || this.heartMode || !this.ai.welcome) return;
		if (this.roles?.['milo-brain'] !== this.selfId || this.welcomed.has(peerId)) return;
		const name = this.names[peerId];
		if (!name) return; // names arrive via hello — the caller retries once it's known
		this.welcomed.add(peerId);
		void this.miloAsk(`A new participant named ${name} just took a seat. Welcome them in one short sentence.`);
	}

	private speakCtx: AudioContext | null = null;

	/** Milo's voice as a real pooled mesh audio track: an AudioContext
	 *  destination whose stream is published tagged 'milo' via replaceTrack
	 *  (no renegotiation). Published once and kept — silent between replies.
	 *  Local playback rides the same remoteStreams['milo'] → SFU-pull path
	 *  every client uses — no ctx.destination tap, so no double audio. */
	private miloAudioOut(): MediaStreamAudioDestinationNode | null {
		try {
			if (!this.miloAudioCtx) this.miloAudioCtx = new AudioContext();
			if (!this.miloDest) {
				this.miloDest = this.miloAudioCtx.createMediaStreamDestination();
				this.streamTags.set(this.miloDest.stream, 'milo');
				this.publishedStreams.add(this.miloDest.stream);
				this.handle.addStream(this.miloDest.stream, undefined, 'milo');
				this.miloStreamFrom = this.selfId;
				this.remoteStreams = { ...this.remoteStreams, milo: this.miloDest.stream };
			}
			return this.miloDest;
		} catch {
			return null; // no WebAudio (test env) — chat still delivers the reply
		}
	}

	/** milo-voice role synthesizes replies — cloud TTS when configured, sherpa
	 *  VITS locally otherwise (and as the fallback when the gateway fails).
	 *  The PCM is pushed into the tagged 'milo' mesh track AND the local
	 *  speaker path so everyone hears him, not just the voice seat. */
	private async speakMilo(text: string) {
		if (this.roles?.['milo-voice'] !== this.selfId) return;
		if (!this.ai.enabled) return;
		let audio: { samples: Float32Array; sampleRate: number } | null = null;
		if (aiEndpoint() && (await this.paid())) {
			audio = await cloudTts(text, this.ai.voice, this.roomCode).catch((e) => {
				if (e instanceof CreditsError) { this.creditsOut = true; invalidateTier(this.roomCode); }
				return null;
			});
			if (audio) this.meter?.tickCall();
		}
		if (!audio) {
			if (this.ttsReady === null) this.ttsReady = await this.tts.init();
			if (!this.ttsReady) return;
			audio = await this.tts.speak(text);
		}
		if (!audio) return;
		const dest = this.miloAudioOut();
		if (!dest || !this.miloAudioCtx) return;
		const ctx = this.miloAudioCtx;
		if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
		const buf = ctx.createBuffer(1, audio.samples.length, audio.sampleRate);
		buf.copyToChannel(audio.samples as Float32Array<ArrayBuffer>, 0);
		const node = ctx.createBufferSource();
		node.buffer = buf;
		this.miloSrc = node;
		node.connect(dest);
		node.onended = () => { node.disconnect(); if (this.miloSrc === node) this.miloSrc = null; };
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
		try { this.miloSrc?.stop(); } catch { /* not started */ }
		this.miloSrc = null;
		this.miloState = 'standby';
		this.miloStopNotice = { by: byPeerId, eventId: crypto.randomUUID() };
	}

	private isoFeedUnsub: (() => void) | null = null;

	private async maybeRecord() {
		// composite (dormant) + any future callers: filter tiles/mix to granters
		this.recorder.setConsented(this.consentedPeers);
		if (this.roles?.['recorder-primary'] === this.selfId || this.roles?.['recorder-standby'] === this.selfId) {
			await this.recorder.start();
		}
		// ISO: every CONSENTING seat records its own raw feed — a peer who
		// denied or never answered produces no ISO track (fail-closed).
		// The frontend owns getUserMedia (join runs capture:false), so borrow
		// its published stream; if it hasn't acquired media yet, retry the
		// gate once a feed appears.
		const feed = this.localMedia?.stream ?? localFeed();
		if (!feed && !this.isoFeedUnsub) {
			this.isoFeedUnsub = onLocalFeed(() => {
				this.isoFeedUnsub = null;
				if (this.recording) void this.maybeRecord();
			});
		}
		if (
			feed && !this.witnessOnly && !this.producerOnly && !this.iso?.running &&
			this.consents[this.selfId] === 'granted'
		) {
			this.iso = new IsoRecorder(this.roomCode, this.roomSecret, this.selfId, () => this.paid());
			this.iso.onSegment = (info) =>
				this.handle.sendRealtime({ t: 'rec-manifest', ...info });
			await this.iso.start(feed).catch((e) => console.warn('[iso] start failed', e));
		}
	}

	/** bumps when finalized recording bytes land in /rec-local — bridge emits `recordings` */
	artifactSeq = $state(0);

	/** stop the recorder and publish real segment blobs into the local artifact store */
	private async finishRecording() {
		await this.iso?.stop();
		const blobs = await this.recorder.stop();
		// paid rooms: ciphertext upload to R2 (rec/cloud seals before PUT —
		// plaintext never leaves the device)
		if (blobs.length && this.roomSecret) {
			const recId = await uploadRecording(this.roomSecret, this.roomCode, blobs);
			if (recId) noteArtifact(this.roomCode, `r2-${recId}`, 0);
		}
		for (const blob of blobs) {
			const key = `local-${crypto.randomUUID()}.webm`;
			try {
				await fetch(`/rec-local/${key}`, { method: 'PUT', body: blob });
				noteArtifact(this.roomCode, key, blob.size);
			} catch {}
		}
		if (blobs.length) this.artifactSeq++;
	}

	/** retention control: erase this room's journaled recording bytes (both paths) */
	async purgeRecordings() {
		await this.recorder.purge();
		await IsoRecorder.purge(this.roomCode);
	}

	/** transcript→clip: fetch + open a sealed ISO segment, trim, return blob URL */
	async clipIsoSegment(rec: string, seg: number, startS: number, endS: number): Promise<string | null> {
		const { clipRemoteSegment } = await import('../rec/clip');
		return clipRemoteSegment(this.roomSecret, this.roomCode, rec, seg, startS, endS);
	}

	requestStick() { this.emitOp({ t: 'stick-request' }); }
	/** ask the holder a question — opens a question moment (floor loans to
	 *  the asker, stick stays reserved for the holder to resume) */
	askQuestion() { this.emitOp({ t: 'stick-request', question: true }); }
	/** end the active question moment — holder resumes the floor */
	endQuestion() { this.emitOp({ t: 'stick-resume' }); }
	passStick() {
		this.emitOp(this.stick.getSnapshot().context.mode === 'circle_round'
			? { t: 'stick-pass' }
			: { t: 'stick-table' });
	}
	tableStick() { this.emitOp({ t: 'stick-table' }); }
	raiseHand(up: boolean) {
		this.handle.sendRealtime({ t: up ? 'hand-raise' : 'hand-lower' });
		if (up) this.raisedHands = new Set([...this.raisedHands, this.selfId]);
		else { this.raisedHands.delete(this.selfId); this.raisedHands = new Set(this.raisedHands); }
	}
	/**
	 * Forget a participant's contributions: captions, chat lines, transcript
	 * context lines attributed to them, their consent record (withdrawing
	 * consent mid-record excludes them via the next setConsented), and their
	 * talk-time accounting. Media already sealed into segments is ciphertext
	 * owned by the host-side assembler — erasure cannot reach it.
	 */
	private purgeContributions(peerId: string) {
		const name = this.names[peerId] ?? (peerId === this.selfId ? this.displayName : null);
		this.captions = this.captions.filter((c) => c.from !== peerId);
		this.chatLog = this.chatLog.filter((c) => c.from !== peerId);
		if (name) this.transcriptWindow = this.transcriptWindow.filter((l) => !l.startsWith(`[${name}]`));
		if (peerId in this.consents) {
			delete this.consents[peerId];
			if (this.recording) this.recorder.setConsented(this.consentedPeers);
		}
		this.talkMs.delete(peerId);
	}

	/** signed self-erasure op — every replica purges this peer's contributions */
	eraseSelf() {
		this.emitOp({ t: 'erasure', scope: 'self', target: this.selfId });
	}

	/** authority-side purge of a participant's contributions */
	eraseParticipant(id: string) {
		if (!this.canManage(this.selfId)) return;
		this.emitOp({ t: 'erasure', scope: 'participant', target: id });
	}

	/** recording requires universal consent — propose first, start when all grant */
	proposeRecording() {
		this.handle.sendRealtime({ t: 'recording-consent', state: 'pending' });
		this.consentAsked = true;
		this.recordingProposer = this.selfId;
		this.consents[this.selfId] = 'granted';
		this.emitOp({ t: 'consent', kind: 'recording', state: 'granted' });
		this.consentPromptAt = Date.now();
		// silent peers are excluded (fail-closed) — don't wait forever for
		// answers; start once everyone answered or the window closes
		window.setTimeout(() => this.maybeStartRecording(), CONSENT_WAIT_MS);
	}
	answerConsent(granted: boolean) {
		this.consents[this.selfId] = granted ? 'granted' : 'denied';
		this.handle.sendRealtime({ t: 'recording-consent', state: granted ? 'granted' : 'denied' });
		this.emitOp({ t: 'consent', kind: 'recording', state: granted ? 'granted' : 'denied' });
		this.consentAsked = false;
		// exclusion reacts live: granted mid-record → join the ISO record;
		// denied mid-record → stop ours and purge our pending segments
		if (this.recording) {
			this.recorder.setConsented(this.consentedPeers);
			if (granted) void this.maybeRecord();
			else void this.iso?.discard();
		}
		this.maybeStartRecording();
	}
	get allConsented() {
		return this.peers.every((p) => this.consents[p] === 'granted') && this.consents[this.selfId] === 'granted';
	}
	/**
	 * Recording consent is exclude-not-block: recording proceeds with only
	 * the participants who granted. Silent peers count as denied
	 * (fail-closed). Everyone not in this set is absent from every record:
	 * no ISO track, no captions, no transcript/recap lines.
	 */
	get consentedPeers(): Set<string> {
		return new Set(
			[this.selfId, ...this.peers].filter((p) => this.consents[p] === 'granted')
		);
	}
	/** is this participant in the record? (granted only — silence excludes) */
	isConsented(peerId: string): boolean {
		return this.consents[peerId] === 'granted';
	}
	private consentPromptAt = 0;
	/**
	 * The proposer fires recording-start once every member has answered or
	 * the wait window closed — non-granters are excluded from the record,
	 * not blockers of it (recording proceeds without them).
	 */
	private maybeStartRecording() {
		if (
			this.consentAsked &&
			this.recordingProposer === this.selfId &&
			!this.recording &&
			(this.peers.every((p) => this.consents[p] !== undefined) ||
				Date.now() - this.consentPromptAt > CONSENT_WAIT_MS)
		) {
			this.consentAsked = false;
			this.emitOp({ t: 'recording-start' });
		}
	}
	startRecording() {
		if (!this.allConsented) {
			this.proposeRecording();
			// solo room: self-consent is the whole quorum — complete it now or
			// the proposal pends forever and prod's 15s start ack times out
			this.maybeStartRecording();
			return;
		}
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
		this.breakout = new BreakoutSession(this.roomSecret, roomId, this.roomCode);
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

	/** stick-hold wall-time per peer — feeds the /talktime notes section */
	private talkMs = new Map<string, number>();

	/**
	 * Facilitation slash commands — typed in prod's own chat box, they write
	 * into the synced notes doc (Yjs syncs to everyone; no new protocol):
	 *   /poll question? | option | option     → synced taskList poll
	 *   /agenda item | item | item            → ordered-list agenda
	 *   /talktime                             → equity report section
	 *   /recap                                → transcript tail as Recap section
	 * Returns true when the text was a command.
	 */
	private facilitate(text: string): boolean {
		const m = text.trim().match(/^\/(poll|agenda|talktime|recap)\s*(.*)$/i);
		if (!m) return false;
		const [, cmd, rest] = m;
		const parts = rest.split('|').map((s) => s.trim()).filter(Boolean);
		if (cmd.toLowerCase() === 'poll' && parts.length >= 3) addPoll(this.notes, parts[0], parts.slice(1));
		else if (cmd.toLowerCase() === 'agenda' && parts.length) addAgenda(this.notes, parts);
		else if (cmd.toLowerCase() === 'talktime')
			addTalkTimeStats(this.notes, Object.fromEntries(this.talkMs), this.names);
		else if (cmd.toLowerCase() === 'recap')
			addSection(this.notes, 'Recap', this.transcriptWindow.slice(-15));
		else return true; // recognized but malformed — don't publish as chat
		return true;
	}

	sendChat(text: string, whisperTo?: string) {
		if (!whisperTo && this.facilitate(text)) return;
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
	askAi(text?: string) { this.handle.sendRealtime({ t: 'ask-ai', text }); void this.maybeMilo(`milo ${text ?? 'check in'}`, this.selfId); }
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
		this.notifyTrTargets();
	}

	// translation-fanout subscribers (stt.ts TranslationFanout) learn every
	// subscription-set change here — declared langs, a peer's tr-lang, a peer
	// leaving — so they can replay buffered finals to newly-added lanes
	private trTargetWatchers = new Set<() => void>();
	watchTrTargets(fn: () => void): () => void {
		this.trTargetWatchers.add(fn);
		return () => {
			this.trTargetWatchers.delete(fn);
		};
	}
	private notifyTrTargets() {
		for (const fn of this.trTargetWatchers) fn();
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
		this.broker.dispose();
		this.meter?.stop();
		this.sensory?.stop();
		void this.sipLeg?.stop();
		this.detachStreamHls();
		this.isoFeedUnsub?.();
		this.isoFeedUnsub = null;
		this.earFeedUnsub?.();
		this.earFeedUnsub = null;
		this.ear?.stop();
		this.ear = null;
		try { this.miloSrc?.stop(); } catch { /* not started */ }
		this.miloSrc = null;
		void this.miloAudioCtx?.close().catch(() => {});
		this.miloAudioCtx = null;
		this.miloDest = null;
		void this.speakCtx?.close().catch(() => {});
		this.speakCtx = null;
		// one last distill so the end of the conversation is remembered —
		// fire-and-forget; the sealed journal write outlives the session
		if (this.memoryOn && this.linesSinceDistill >= 5 && this.roles?.['milo-brain'] === this.selfId) {
			this.linesSinceDistill = 999;
			this.lastDistillAt = 0;
			this.maybeDistill();
		}
		this.miloMem = [];
		this.memRecalled = false;
		this.linesSinceDistill = 0;
		this.lastDistillAt = 0;
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
