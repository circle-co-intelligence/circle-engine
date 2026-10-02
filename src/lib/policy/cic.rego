package cic

# CIC room policies — declarative rules evaluated by OPA-Wasm.
# Inputs: { op, actor, state } — see wire/messages.ts for shapes.

# --- mute sovereignty -------------------------------------------------------
# effectiveMuted = selfMuted OR autoMuted OR remotelyMuted
effective_muted(p) := true if {
	p.selfMuted
} else := true if {
	p.autoMuted
} else := p.remotelyMuted

# No remote operation may force-open a microphone.
allow_remote_unmute := false

deny contains "remote unmute forbidden" if {
	input.op.t == "unmute-remote"
}

deny contains "rejoin cannot unmute" if {
	input.op.t == "rejoin"
	input.op.setsMuted == false
}

# --- consent ----------------------------------------------------------------
deny contains "recording requires universal consent" if {
	input.op.t == "recording-start"
	some p in input.state.occupants
	p.recordingConsent != "granted"
}

deny contains "transcript requires scope consent" if {
	input.op.t == "transcript-line"
	input.state.config.transcriptScope == "off"
}

deny contains "heart mode disables capture" if {
	input.op.t == "caption-capture"
	input.state.config.heartMode == true
}

# --- authority / admission --------------------------------------------------
deny contains "not room authority" if {
	input.op.t == "admit"
	input.actor.id != input.state.authorityId
}

deny contains "seat already occupied" if {
	input.op.t == "seat-claim"
	input.state.seats[sprintf("%d", [input.op.seat])] != null
}

# --- stick sovereignty ------------------------------------------------------
deny contains "holder only" if {
	input.op.t == "stick-pass"
	input.actor.id != input.state.stick.holderId
}

deny contains "mode change requires manager" if {
	input.op.t == "mode-set"
	not input.actor.canManageRoom
}

deny contains "breakout requires manager" if {
	input.op.t == "breakout-open"
	not input.actor.canManageRoom
}

deny contains "breakout close requires manager" if {
	input.op.t == "breakout-close"
	not input.actor.canManageRoom
}

deny contains "remote mute requires manager" if {
	input.op.t == "mute-set"
	not input.actor.canManageRoom
}

deny contains "peer removal requires manager" if {
	input.op.t == "peer-remove"
	not input.actor.canManageRoom
}

deny contains "peer cannot remove self" if {
	input.op.t == "peer-remove"
	input.op.id == input.actor.id
}

deny contains "password requires manager" if {
	input.op.t == "password-set"
	not input.actor.canManageRoom
}

deny contains "lobby change requires manager" if {
	input.op.t == "lobby-set"
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
