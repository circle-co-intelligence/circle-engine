import { z } from 'zod';

/**
 * CIC wire protocol — zod is the single source of truth.
 * Message-type names verified against the deployed production bundle
 * (see docs/PROTOCOL.md for the extraction evidence).
 *
 * Envelope: { v, t, seq, roomEpoch, senderId, sig }
 * Every op is signed (Ed25519 over canonical JSON) and carries the room
 * epoch it was authored under — stale-epoch ops are rejected.
 */

export const PROTOCOL_VERSION = 1 as const;

export const participantId = z.string().min(8).max(64); // opaque, random per room
export const epoch = z.number().int().nonnegative();
export const opId = z.string().min(16);

export const roomMode = z.enum(['open_round', 'circle_round']);
export const direction = z.enum(['sunwise', 'earthwise']); // clockwise / counter-clockwise
export const stickState = z.enum(['on_table', 'held', 'in_pass', 'question']);
export const transcriptScope = z.enum(['off', 'holder', 'all']);
export const recordingConsent = z.enum(['pending', 'granted', 'denied']);

export const roomConfig = z.object({
	mode: roomMode,
	direction,
	speakingTimerSeconds: z.number().int().positive().max(3600).optional(),
	speakingTimerEveryone: z.boolean(),
	heartMode: z.boolean(),
	transcriptScope,
	recording: z.boolean(),
	maxSeats: z.number().int().min(2).max(64),
	questionMoments: z.boolean()
});

/** ops admitted to the signed op-log (authoritative room state transitions) */
export const op = z.discriminatedUnion('t', [
	z.object({ t: z.literal('stick-request'), question: z.boolean().optional() }),
	z.object({ t: z.literal('stick-grant'), to: participantId }),
	z.object({ t: z.literal('stick-give'), to: participantId }), // prod: give-stick — holder hands to a specific seat
	z.object({ t: z.literal('stick-pass'), to: participantId.optional() }), // destination is forced to next seat — `to` is log notation only
	z.object({ t: z.literal('stick-table') }), // return to table
	z.object({ t: z.literal('stick-resume') }), // holder returns after question moment
	z.object({ t: z.literal('mode-set'), mode: roomMode }),
	z.object({ t: z.literal('direction-set'), direction }),
	z.object({ t: z.literal('config-set'), patch: roomConfig.partial() }),
	z.object({ t: z.literal('consent'), kind: z.enum(['recording', 'transcript']), state: recordingConsent }),
	// self-attributed Milo-hearing consent: the signer's own ASR finals may be
	// forwarded to the milo-brain seat (see milo-hear). Off by default —
	// absence of an ear-set op for a peer = not heard.
	z.object({ t: z.literal('ear-set'), on: z.boolean() }),
	z.object({ t: z.literal('recording-start') }),
	z.object({ t: z.literal('recording-stop') }),
	z.object({ t: z.literal('room-end') }),
	z.object({
		t: z.literal('breakout-open'),
		count: z.number().int().min(1).max(8),
		freeJoin: z.boolean().optional(),
		allowReturn: z.boolean().optional(),
		names: z.array(z.string()).optional()
	}),
	z.object({ t: z.literal('breakout-close') }),
	z.object({ t: z.literal('heart-set'), on: z.boolean() }), // Heart-Sharing forces rec/transcription off
	z.object({ t: z.literal('lobby-set'), enabled: z.boolean() }),
	z.object({ t: z.literal('co-host-set'), id: participantId, on: z.boolean() }),
	z.object({ t: z.literal('started-set'), on: z.boolean() }), // circle formally opened/closed by host
	z.object({ t: z.literal('host-locks-set'), locks: z.record(z.string(), z.boolean()) }),
	z.object({
		t: z.literal('appearance-set'),
		theme: z.string().max(40).optional(),
		accent: z.string().max(40).optional(),
		center: z.string().max(80).optional(),
		miloVisual: z.string().max(80).optional(),
		stick: z.string().max(80).optional(),
		background: z.string().max(80).optional(),
		backgroundColor: z.string().max(40).optional(),
		panelColor: z.string().max(40).optional()
	}),
	z.object({
		t: z.literal('ai-set'),
		name: z.string().max(80).optional(),
		enabled: z.boolean().optional(),
		transcription: z.boolean().optional(),
		contextProcessing: z.boolean().optional(),
		instructions: z.string().max(4000).optional(),
		voice: z.string().max(80).optional(),
		standby: z.boolean().optional(),
		scope: z.string().max(40).optional(),
		storeTranscript: z.boolean().optional(),
		// brain override: auto = cloud when entitled, local wllama otherwise;
		// 'local' forces the on-device brain (privacy rooms), 'cloud' refuses
		// the local fallback (zero-retention-only rooms)
		brain: z.enum(['auto', 'local', 'cloud']).optional(),
		// facilitation acts — each individually opt-in; Milo still never holds
		// the floor, he speaks into the open floor between turns
		roundSummary: z.boolean().optional(), // summarize at each circle_round completion
		equityNudge: z.boolean().optional(),  // nudge when talk-time skews and floor is free
		welcome: z.boolean().optional(),      // greet a newly seated peer by name
		// persistent host-anchored memory — distill + recall across sessions
		// of the same room. On by default once ai is enabled; off stops
		// writing (stored items are wiped via 'milo forget everything').
		memory: z.boolean().optional()
	}),
	z.object({ t: z.literal('milo-wake-set'), mode: z.enum(['hey_milo', 'click']) }),
	z.object({ t: z.literal('mute-set'), id: participantId, kind: z.enum(['audio', 'video']), on: z.boolean() }), // authority remote-mute — can never force-open
	z.object({ t: z.literal('peer-remove'), id: participantId }), // host kick — the ejected peer's own session terminates on apply
	z.object({ t: z.literal('password-set'), hash: z.string().max(128) }), // sha256(code + ':' + password); '' clears
	z.object({ t: z.literal('tr-fanout-set'), lanes: z.array(z.string().max(12)).max(16) }),
	z.object({ t: z.literal('turn-timer-set'), minutes: z.number().int().min(0).max(120) }),
	z.object({ t: z.literal('erasure'), scope: z.enum(['self', 'participant']), target: participantId })
]);
export type Op = z.infer<typeof op>;

/** signed op-log envelope — the ONLY authoritative state channel */
export const opEnvelope = z.object({
	v: z.literal(PROTOCOL_VERSION),
	t: z.literal('op'),
	opId,
	roomEpoch: epoch,
	senderId: participantId,
	sentAt: z.number().int(), // authority clock, not wall clock
	op,
	sig: z.string() // Ed25519 signature over canonical(op without sig)
});
export type OpEnvelope = z.infer<typeof opEnvelope>;

/** non-authoritative realtime messages (presence/ephemeral channels) */
export const realtimeMessage = z.discriminatedUnion('t', [
	z.object({
		t: z.literal('hello'),
		name: z.string().max(80),
		cap: z.array(z.string()),
		// optional: the peer's SFU session id when it publishes via a cloud
		// SFU — lets subscribers map mesh peerId → remote track location.
		// Extended form also carries the publication trackNames so pulls bind
		// to real names instead of convention.
		sfu: z
			.union([
				z.string().max(80),
				z.object({
					session: z.string().max(80),
					tracks: z.array(z.string().max(40)).max(8)
				})
			])
			.optional()
	}),
	z.object({ t: z.literal('admit'), to: participantId }),
	z.object({ t: z.literal('hand-raise') }),
	z.object({ t: z.literal('hand-lower') }),
	z.object({ t: z.literal('reaction'), emoji: z.string().max(8) }),
	z.object({ t: z.literal('chat'), text: z.string().max(4000), whisperTo: participantId.optional() }),
	z.object({ t: z.literal('caption-update'), text: z.string().max(500), final: z.boolean(), lang: z.string().max(12) }),
	z.object({ t: z.literal('caption-sections'), update: z.record(z.string(), z.any()) }), // prod-shaped personal-caption update (sourceId/generation/sections)
	z.object({ t: z.literal('recording-consent'), state: recordingConsent }), // prod-verbatim name
	z.object({ t: z.literal('recording-state'), active: z.boolean() }),
	z.object({ t: z.literal('authority-heartbeat'), leaseUntil: z.number().int() }),
	z.object({ t: z.literal('breakout-assign'), room: z.string(), to: participantId }),
	z.object({ t: z.literal('breakout-move'), channel: z.number().int().min(0).max(64) }),
	z.object({ t: z.literal('breakout-return') }),
	z.object({ t: z.literal('breakout-broadcast'), text: z.string().max(500) }),
	z.object({ t: z.literal('away'), on: z.boolean() }),
	z.object({ t: z.literal('sharing'), on: z.boolean(), audio: z.boolean().optional() }), // screen share presence
	z.object({ t: z.literal('rename'), name: z.string().max(80) }),
	z.object({ t: z.literal('muted'), audio: z.boolean(), video: z.boolean() }), // per-kind self-declared state
	z.object({ t: z.literal('notes'), text: z.string().max(200_000) }), // collaborative notes (last-writer)
	z.object({ t: z.literal('ask-ai'), text: z.string().max(2000).optional() }), // explicit Milo ask
	z.object({ t: z.literal('reaction-kind'), kind: z.string().max(24), name: z.string().max(80).optional() }),
	z.object({ t: z.literal('lobby-join'), name: z.string().max(80) }), // announce self into waiting room
	z.object({ t: z.literal('lobby-wait') }), // member confirms: you're in the waiting room
	// manager-owned waiting list — members adopt it so heldPeers/waiting converge
	// across sessions whose lobbyEnabled learned the lobby-set at different times
	z.object({
		t: z.literal('lobby-waiting'),
		entries: z.array(z.object({ id: participantId, name: z.string().max(80), joinedAt: z.number().int() })).max(200)
	}),
	z.object({ t: z.literal('lobby-decline'), to: participantId }), // host declined a waiting joiner
	z.object({ t: z.literal('access-denied') }), // password proof failed — joiner leaves
	// late-joiner catch-up: a member replays its signed op-log to a new peer;
	// each op re-verifies signature + policy, epoch follows the replayed log
	z.object({ t: z.literal('op-sync'), ops: z.array(opEnvelope).max(4096) }),
	z.object({ t: z.literal('milo-state'), state: z.enum(['off', 'standby', 'listening', 'speaking']) }),
	z.object({ t: z.literal('milo-stop') }), // anyone may rest Milo — prod's "Stop" control
	// ear lane: a consenting peer's own-ASR final line, sent ONLY to the
	// milo-brain seat — feeds Milo's transcriptWindow without rendering as a
	// caption. Never broadcast; heartMode suppresses these entirely.
	z.object({ t: z.literal('milo-hear'), text: z.string().max(500), lang: z.string().max(12).optional() }),
	// milo-mem — persistent memory sync between the brain seat and the
	// authority (the room's memory host, sealed per-room in its journal):
	//   brain → authority {items}        store these distilled facts
	//   brain → authority {req:true}     send me this room's memories
	//   authority → brain {items,recall} recall payload for the session
	//   brain → authority {wipe}         manager-gated room wipe
	//   brain → authority {forget}       purge one speaker's items
	// Never broadcast — targeted sends only, text is sealed at rest anyway.
	z.object({
		t: z.literal('milo-mem'),
		req: z.boolean().optional(),
		recall: z.boolean().optional(),
		wipe: z.boolean().optional(),
		forget: z.string().max(80).optional(), // peerId to purge
		items: z.array(z.object({ text: z.string().max(300), by: z.string().max(80).optional() })).max(50).optional()
	}),
	z.object({ t: z.literal('tr-lang'), lang: z.string().max(12), langs: z.array(z.string().max(12)).max(8) }), // participant's caption/translation language preference
	// translated segment fanout — the speaker's device translates its own ASR
	// output and ships tr-caption/caption-audio payloads to subscribers; the
	// remote bridge re-emits them on that subscriber's room socket
	z.object({
		t: z.literal('tr-segment'),
		to: participantId,
		lang: z.string().max(12),
		which: z.enum(['partial', 'final']),
		delta: z.string().max(2000),
		sourceId: z.string(),
		generation: z.string(),
		pcm: z.string().max(400_000).optional(),
		cueId: z.number().int().optional(),
		original: z.string().max(2000).optional(),
		/** ISO code the ASR detected for this segment — subscribers render it,
		 *  and it documents which direction the translation ran */
		originalLang: z.string().max(12).optional()
	}),
	z.object({ t: z.literal('e2ee-key'), epoch, data: z.string() }), // wrapped EpochAnnouncement (JSON)
	// beyond-GCC bandwidth broker: peers report link stats to the elected
	// bw-allocator; it broadcasts a per-peer sender budget — cross-flow
	// coordination libwebrtc's per-flow congestion control can't do
	z.object({ t: z.literal('bw-stats'), rttMs: z.number(), estKbps: z.number() }),
	// capability auction input: each peer announces its Capability record so
	// electAll() scores the same set everywhere — without this every node
	// elects itself for every role (milo-brain fork)
	z.object({
		t: z.literal('capability'),
		cpuScore: z.number(),
		memoryGB: z.number(),
		batterySaver: z.boolean(),
		webgpu: z.boolean(),
		models: z.array(z.string().max(40)).max(16),
		uplinkKbps: z.number(),
		isRecorderDevice: z.boolean()
	}),
	z.object({ t: z.literal('bw-budget'), limit: z.number().int() }),
	// per-receiver layer selection: a receiver asks the sender to activate
	// one rid on JUST our pc — mesh simulcast without an SFU. 'none' drops
	// the video leg entirely (witnesses hold audio + stage video only)
	z.object({ t: z.literal('pull-hint'), rid: z.enum(['f', 'h', 'q', 'none']) }),
	// webinar fanout: authority announces a Cloudflare Stream live HLS
	// manifest — witnesses past the mesh scale ceiling play it instead of
	// pulling per-peer tracks (code-ready for CF Stream creds, B3)
	z.object({ t: z.literal('stream-manifest'), hls: z.string().max(500) }),
	// ISO recording manifest: each recorder announces sealed segments as it
	// uploads — the host assembles the multi-track index from these
	z.object({
		t: z.literal('rec-manifest'),
		rec: z.string().max(64), // recording id
		seg: z.number().int().min(0),
		durationMs: z.number().min(0),
		bytes: z.number().int().min(0),
		ts: z.number().int()
	})
]);
export type RealtimeMessage = z.infer<typeof realtimeMessage>;

/** room state snapshot — derived from op-log replay; persisted as checkpoint */
export const roomState = z.object({
	epoch,
	config: roomConfig,
	seats: z.record(z.string(), participantId.nullable()), // seat index -> occupant
	occupants: z.record(z.string(), z.object({
		name: z.string(),
		raisedHand: z.boolean(),
		selfMuted: z.boolean(),
		autoMuted: z.boolean(),
		remotelyMuted: z.boolean(),
		joinedAtOp: z.string(), // op id when known; '' is fine — policy never reads it
		recordingConsent: recordingConsent.optional() // deny-veto input for recording-start
	})),
	stick: z.object({
		state: stickState,
		holderId: participantId.nullable(),
		atSeatOf: participantId.nullable(), // seat the stick conceptually rests at during question
		resumeTo: participantId.nullable(),
		questionActive: z.boolean()
	}),
	recording: z.object({
		active: z.boolean(),
		startedBy: participantId.nullable(),
		consentRequired: z.boolean()
	}),
	authorityId: participantId.nullable(),
	roles: z.object({
		miloBrain: participantId.nullable(),
		miloVoice: participantId.nullable(),
		recorderPrimary: participantId.nullable(),
		recorderStandby: participantId.nullable()
	})
});
export type RoomState = z.infer<typeof roomState>;
