package cic

# CIC room policies — declarative rules evaluated by OPA-Wasm.
# Inputs: { op, actor, state } — see wire/messages.ts for shapes.
#
# Enforcement scope: signed ops only. Realtime frames (transcript-line,
# recording-consent, captions, hand-raise) never enter the op log — their
# guarantees are enforced where the media flows (consent-scoped recorder
# exclusion, heart-mode capture kill in applyOp), not here.

# --- mute sovereignty -------------------------------------------------------
# effectiveMuted = selfMuted OR autoMuted OR remotelyMuted
effective_muted(p) := true if {
	p.selfMuted
} else := true if {
	p.autoMuted
} else := p.remotelyMuted

# Remote unmute is impossible at the protocol level: a remote-targeted
# mute-set may only ever close. Self-mute travels by realtime, not ops,
# so on:false here is always a remote-unmute attempt — deny outright.
deny contains "remote unmute forbidden" if {
	input.op.t == "mute-set"
	input.op.on == false
}

# --- manager-gated room control ---------------------------------------------
# The circle's keeper (authority or co-host, canManageRoom) owns the room's
# form: mode, direction, timers, lobby, co-hosts, appearance, AI seat,
# breakouts, admission controls, force-mute, removal, ending the room.
manager_ops := {
	"mode-set",
	"direction-set",
	"config-set",
	"turn-timer-set",
	"heart-set",
	"lobby-set",
	"co-host-set",
	"started-set",
	"host-locks-set",
	"appearance-set",
	"ai-set",
	"milo-wake-set",
	"tr-fanout-set",
	"password-set",
	"breakout-open",
	"breakout-close",
	"mute-set",
	"peer-remove",
	"stick-grant",
	"room-end",
}

deny contains sprintf("%s requires manager", [input.op.t]) if {
	input.op.t in manager_ops
	not input.actor.canManageRoom
}

deny contains "peer cannot remove self" if {
	input.op.t == "peer-remove"
	input.op.id == input.actor.id
}

# --- seating ----------------------------------------------------------------
deny contains "seat already occupied" if {
	input.op.t == "seat-claim"
	input.state.seats[sprintf("%d", [input.op.seat])] != null
}

# --- stick sovereignty ------------------------------------------------------
# Only the holder may pass — the floor is theirs to yield.
deny contains "holder only" if {
	input.op.t == "stick-pass"
	input.actor.id != input.state.stick.holderId
}

# Placing the stick down / handing it to a seat: the holder's own move, or
# the keeper's (host-set-current, host retrieves the stick to the table).
deny contains "table requires holder or manager" if {
	input.op.t == "stick-table"
	input.actor.id != input.state.stick.holderId
	not input.actor.canManageRoom
}

deny contains "give requires holder or manager" if {
	input.op.t == "stick-give"
	input.actor.id != input.state.stick.holderId
	not input.actor.canManageRoom
}

# Resuming after a question moment: the asker (atSeatOf) ends their moment,
# or the holder reclaims, or the keeper intervenes.
deny contains "resume requires holder, asker, or manager" if {
	input.op.t == "stick-resume"
	input.actor.id != input.state.stick.holderId
	input.actor.id != input.state.stick.atSeatOf
	not input.actor.canManageRoom
}

# --- consent ----------------------------------------------------------------
# Recording is consent-scoped exclusion, not a block: the record contains
# only granting participants and silence counts as not-granted (the recorder
# composes consentedPeers only). Policy's part is the hard veto — nobody who
# explicitly denied may appear in a started record.
deny contains "recording includes a denying participant" if {
	input.op.t == "recording-start"
	some p in input.state.occupants
	p.recordingConsent == "denied"
}

# Stopping a recording belongs to its starter or the keeper.
deny contains "recording stop requires starter or manager" if {
	input.op.t == "recording-stop"
	input.actor.id != input.state.recording.startedBy
	not input.actor.canManageRoom
}

# --- erasure ----------------------------------------------------------------
deny contains "erasure only self or authority" if {
	input.op.t == "erasure"
	input.op.scope == "participant"
	input.actor.id != input.state.authorityId
}

# verdict: no deny rules fired
default allow := false
allow if {
	count(deny) == 0
}
