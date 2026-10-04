# Discrepancies — spec vs production bundle vs this implementation

| # | Item | Production bundle | This implementation | Status |
|---|---|---|---|---|
| D1 | Stick fields `holderId`/`atSeatOf`/`resumeTo`/`on_table` | confirmed verbatim | same names, same semantics (stick.machine.ts) | aligned |
| D2 | `sunwise`/`earthwise` direction | confirmed | implemented via seat-order reversal | aligned |
| D3 | `circle_round`/`open_round` modes | confirmed | XState guards — pass is deterministic in circle_round | aligned |
| D4 | Captions via server tickets + Deepgram/OpenAI | confirmed (CSP) | sherpa-onnx WASM in-browser | deviation (privacy improvement) |
| D5 | Server recording (`rec-upload`, `rec-server`) | confirmed | peer recorder roles + OPFS | deviation (survivability improvement) |
| D6 | CF Insights beacon in shell | confirmed present | none | deviation (privacy improvement) |
| D7 | Lobby/`admit` flow | confirmed | authority approval queue (`lobby-wait`/`lobby-join`/`admit`), probe-verified | aligned |
| D8 | `whisper` channel | confirmed | `chat.whisperTo` — targeted data-channel delivery: only the recipient ever receives the frame (DTLS pairwise). Room-key scope is irrelevant at the wire level; no separate key needed | aligned |
| D9 | `milo-wake` | confirmed | transcript-driven wake: `hey_milo` mode widens the Milo trigger to "hey milo" mid-utterance across ASR finals (self + peers). No separate KWS model — the sherpa ASR already streams the room's speech | aligned |
| D10 | `recording-purchase`/`recording-budget` | confirmed — paid path exists in prod | cic-cloud metering (B.14) | planned |
| D11 | `speakingTimerEveryone`, `heartMode`, `canManageRoom` | confirmed | in roomConfig schema | aligned |
| D12 | Two-step bypass prevention | not directly observable | structurally impossible in machine def | aligned |
