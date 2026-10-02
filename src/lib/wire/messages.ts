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
export const seatIndex = z.number().int().min(0).max(63);
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
	z.object({ t: z.literal('seat-claim'), seat: seatIndex }),
	z.object({ t: z.literal('seat-release') }),
	z.object({ t: z.literal('stick-request'), question: z.boolean().optional() }),
	z.object({ t: z.literal('stick-grant'), to: participantId }),
	z.object({ t: z.literal('stick-give'), to: participantId }), // prod: give-stick — holder hands to a specific seat
	z.object({ t: z.literal('stick-pass'), to: participantId }),
	z.object({ t: z.literal('stick-table') }), // return to table
	z.object({ t: z.literal('stick-resume') }), // holder returns after question moment
	z.object({ t: z.literal('mode-set'), mode: roomMode }),
	z.object({ t: z.literal('direction-set'), direction }),
	z.object({ t: z.literal('config-set'), patch: roomConfig.partial() }),
	z.object({ t: z.literal('consent'), kind: z.enum(['recording', 'transcript']), state: recordingConsent }),
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
		storeTranscript: z.boolean().optional()
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
	z.object({ t: z.literal('hello'), name: z.string().max(80), cap: z.array(z.string()) }),
	z.object({ t: z.literal('welcome'), roomEpoch: epoch, yourId: participantId }),
	z.object({ t: z.literal('snapshot'), state: z.string() }), // encrypted checkpoint blob ref
	z.object({ t: z.literal('delta') }),
	z.object({ t: z.literal('lobby-request'), name: z.string().max(80), proof: z.string().optional() }),
	z.object({ t: z.literal('admit'), to: participantId }),
	z.object({ t: z.literal('hand-raise') }),
	z.object({ t: z.literal('hand-lower') }),
	z.object({ t: z.literal('mute-state'), muted: z.boolean() }),
	z.object({ t: z.literal('reaction'), emoji: z.string().max(8) }),
	z.object({ t: z.literal('chat'), text: z.string().max(4000), whisperTo: participantId.optional() }),
	z.object({ t: z.literal('caption-update'), text: z.string().max(500), final: z.boolean(), lang: z.string().max(12) }),
	z.object({ t: z.literal('caption-sections'), update: z.record(z.string(), z.any()) }), // prod-shaped personal-caption update (sourceId/generation/sections)
	z.object({ t: z.literal('transcript-line'), seq: z.number().int(), hash: z.string(), scope: transcriptScope }),
	z.object({ t: z.literal('recorder-heartbeat'), role: z.enum(['primary', 'standby']) }),
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
		original: z.string().max(2000).optional()
	}),
	z.object({ t: z.literal('e2ee-key'), epoch, data: z.string() }), // wrapped EpochAnnouncement (JSON)
	z.object({ t: z.literal('sas'), emoji: z.string().max(16) }) // emoji fingerprint verify
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
		joinedAtOp: opId
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
