/**
 * wsRoom — a Trystero-compatible room facade over the cic-signaling
 * Durable-Object bus. The bus relays opaque {to?, data} frames between room
 * members over one WebSocket; we run the WebRTC handshake ourselves:
 *
 *   newcomer → offer to every established member (welcome.members)
 *   member   → answer on offer; candidates relayed both ways
 *
 * Glare avoidance is architectural, not recovery-based: the bus has no
 * symmetric "a peer joined" notification (only the newcomer learns of
 * existing members and can initiate contact), so the newcomer who created
 * the signaling channel is permanently the 'initiator' for that pair — it
 * is the ONLY side ever allowed to call setLocalDescription() to make an
 * offer, for the lifetime of the connection. The acceptor only ever
 * answers.
 *
 * Media is renegotiation-free by construction: the initiator's single
 * offer carries a fixed pool of `sendrecv` transceivers (POOL_AUDIO +
 * POOL_VIDEO) created before the offer. Both sides then publish and
 * unpublish tracks purely with RTCRtpSender.replaceTrack(), which needs no
 * signaling at all — so a pc does AT MOST ONE offer/answer cycle ever.
 * This matters because some runtimes (this WebKitGTK build) deadlock the
 * whole WebProcess on a second setLocalDescription() against an already-
 * PLAYING webrtcbin, and can crash outright if close() races an in-flight
 * setLocalDescription (see pendingLocalOp/safeClose below).
 *
 * On the receive side every pooled transceiver has a receiver track from
 * negotiation time; it un-mutes when the remote actually starts sending.
 * Tracks are merged into one MediaStream per peer (the session layer
 * collapses remoteStreams to one stream per peer anyway), so no app-level
 * stream-map protocol is needed — receiver 'unmute' is the real "media
 * arrived" signal.
 *
 * App traffic rides a 'cic' datachannel — makeAction namespaces work
 * exactly like Trystero's — AND a parallel encrypted copy over the bus
 * (`app` payload): this WebKitGTK build negotiates SCTP but never flips
 * RTCDataChannel to 'open', so the bus keeps ops/realtime/custom actions
 * flowing. Receivers dedupe across both transports.
 *
 * Peer ids are announced as `sid` inside signaling payloads so a peer
 * reachable on this lane AND a relay lane merges under the same id. The
 * bus sees only hashed room keys (sha256(secret)) and opaque signaling
 * blobs — the room secret never leaves the client.
 *
 * RUNTIME QUIRK — always-initiator mode (ALWAYS_INITIATE): this WebKitGTK
 * build deadlocks the WebProcess while *applying* a remote offer (the
 * webrtcbin _set_description_task stalls before the answer is ever
 * created), but its offerer path is healthy — offers negotiate, ICE/DTLS
 * complete, media flows. So on that runtime the room never accepts an
 * offer: incoming offers are ignored and answered with a counter-offer
 * instead. For the far side this looks like ordinary glare — resolved by
 * the existing sid tiebreak (larger sid keeps its offer) — so the local
 * sid is emitted with a '~' prefix to sort above every trystero selfId
 * ([0-9A-Za-z]), making this end the permanent initiator. Two
 * always-initiator peers can never connect (one side must answer), which
 * is an accepted limitation: the underlying engine cannot answer at all.
 */
import { selfId } from 'trystero/mqtt';
import type { Room } from 'trystero';
import { normalizeExtmaps } from './sdp';

interface BusFrame {
	t: 'welcome' | 'join' | 'leave' | 'msg';
	id?: string;
	from?: string;
	to?: string;
	members?: string[];
	data?: Sig;
}
interface Sig {
	sid: string; // remote trystero selfId — merges membership across lanes
	sdp?: { type: RTCSdpType; sdp: string };
	cand?: RTCIceCandidateInit;
	// bus-relayed app traffic (base64 AES-GCM envelope of {ns,data}) — the
	// datachannel is the preferred transport, but some runtimes (this
	// WebKitGTK build) negotiate SCTP and then never flip RTCDataChannel to
	// 'open', making dc.send() unusable forever. The bus copy is encrypted
	// with a key derived from the room secret so the relay still sees only
	// opaque blobs.
	app?: string;
}
// internal app namespace: publisher → receiver "pool transceiver index i is
// a real claimed media slot" (and its release). Needed because some engines
// send padding/keepalive RTP on negotiated-but-unclaimed sendrecv m-lines,
// which un-mutes the receiver track — without the map we cannot tell a real
// published stream apart from padding noise.
const SMAP_NS = '__wsroom_smap__';
interface SmapFrame {
	i: number;
	off?: boolean;
}
interface Peer {
	busId: string;
	sid: string;
	pc: RTCPeerConnection;
	dc: RTCDataChannel | null;
	makingOffer: boolean;
	ignoreOffer: boolean; // defensive fallback: impolite peer ignores remote offer while offering
	joined: boolean; // join listeners fired once media can flow AND the real sid is known
	// this WebKitGTK build crashes the WebProcess outright if close() races an
	// in-flight setLocalDescription/createAnswer — always await this before
	// closing a pc (see safeClose/rebuildPc)
	pendingLocalOp: Promise<unknown>;
	// fixed for the connection's lifetime: true for the side that created the
	// datachannel (the newcomer who learned of this peer first) — only this
	// side ever offers. See file header.
	initiator: boolean;
	offered: boolean; // initiator only: initial (and only) offer already sent
	// local publish bookkeeping: which pooled transceiver index each of our
	// outgoing tracks occupies (replaceTrack target)
	claims: Map<MediaStreamTrack, number>;
	// receive side: pool indices the remote has announced as real claimed
	// slots (SMAP_NS), plus tracks pending adoption until their index maps
	mapped: Set<number>;
	pendingIdx: Set<number>;
	// receive side: one merged MediaStream carrying every remote receiver
	// track that has ever delivered media
	recvStream: MediaStream;
	recvSeen: Set<MediaStreamTrack>;
	// serializes decrypt→dispatch of bus-relayed app frames so per-peer
	// ordering matches arrival order
	appChain: Promise<unknown>;
}

// fixed sendrecv transceiver pool — sized for camera + screen + headroom.
// Never renegotiate: if the pool fills, extra tracks are dropped with a
// warning rather than risking a runtime-killing re-offer.
const POOL_AUDIO = 2;
const POOL_VIDEO = 3;

async function roomKey(secret: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// app frames relayed over the bus are AES-GCM encrypted with a key derived
// from the room secret — the bus relays only opaque ciphertext, same as the
// signaling blobs it already carries
async function appKey(secret: string): Promise<CryptoKey> {
	const raw = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`cic-app:${secret}`)
	);
	return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
		'encrypt',
		'decrypt'
	]);
}
const b64 = (buf: ArrayBuffer | Uint8Array) => {
	const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let s = '';
	for (const x of b) s += String.fromCharCode(x);
	return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function openWsRoom(
	busUrl: string,
	roomSecret: string,
	rtcConfig: RTCConfiguration,
	onBusState?: (state: 'up' | 'down') => void
): Promise<Room> {
	const joinListeners = new Set<(peerId: string) => void>();
	const leaveListeners = new Set<(peerId: string) => void>();
	const streamListeners = new Set<(stream: MediaStream, peerId: string) => void>();
	const actionListeners = new Map<string, Set<(data: unknown, peerId: string) => void>>();

	// peers keyed by the remote's trystero selfId ('pending:*' until their first
	// signaling payload announces it); byBusId indexes the same Peer objects by
	// bus member id so leave/retarget frames resolve before the sid is known
	const peers = new Map<string, Peer>();
	const byBusId = new Map<string, Peer>();
	const findPeer = (busId: string, sid?: string): Peer | undefined =>
		(sid ? peers.get(sid) : undefined) ?? byBusId.get(busId);

	let ws: WebSocket | null = null;
	let myBusId = '';
	let disposed = false;
	let attempts = 0;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	const keyP = appKey(roomSecret);

	// ALWAYS_INITIATE (see file header): runtimes that cannot apply a remote
	// offer must be the permanent initiator for every pair. Detected by the
	// Tauri custom-protocol origin; overridable for browser-based testing.
	const alwaysInitiate =
		(import.meta.env.VITE_CIC_ALWAYS_INITIATE ?? '') === '1' ||
		(typeof location !== 'undefined' && location.protocol === 'tauri:');
	// '~' sorts above every char in trystero's selfId alphabet, so this sid
	// always wins the collision tiebreak — remote peers always yield and
	// answer our offer instead of the reverse.
	const ourSid = alwaysInitiate ? `~${selfId}` : selfId;

		const send = (p: Peer, data: Sig) => {
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ to: p.busId, data }));
	};

	// this WebKitGTK build can emit SDP other engines refuse to parse
	// (Chromium: "Failed to parse SessionDescription") in two ways:
	//  1. a=bundle-only markers without an a=group:BUNDLE session line —
	//     without a group the m-lines are individually transportable, so
	//     the honest repair is to drop the marker.
	//  2. payload types allocated incrementally across m-lines, overflowing
	//     the 7-bit RTP pt space (>=128 on the 6th pooled m-line). PTs are
	//     section-scoped, so any overflowing section is remapped onto
	//     96..96+n-1 and its rtpmap/rtcp-fb/fmtp references rewritten.
	//  3. extmap ids reused per-section (id 5 = ssrc-audio-level in audio,
	//     = color-space in video) — legal unbundled, but a BUNDLE group
	//     requires one id ↔ uri mapping across all m-lines. Ids are
	//     renumbered so each extmap URI owns one global id.
	const fixSdp = (sdp: string): string => {
		let out = sdp;
		if (!out.includes('a=group:BUNDLE') && out.includes('a=bundle-only'))
			out = out.replace(/^a=bundle-only\r?\n/gm, '');
		// pass 1: assign each extmap URI a single global id (needed only when
		// the same id maps different URIs across bundled m-lines)
		const uriId = new Map<string, number>();
		const seen = new Map<number, string>(); // id -> uri
		let collision = false;
		for (const m of out.matchAll(/^a=extmap:(\d+)(?:\/\w+)?\s+(\S+)/gm)) {
			const id = Number(m[1]);
			const uri = m[2];
			if (seen.has(id) && seen.get(id) !== uri) collision = true;
			if (!uriId.has(uri)) uriId.set(uri, uriId.size + 1);
			seen.set(id, uri);
		}
		const extGlobal = collision ? uriId : null;
		const lines = out.split(/\r?\n/);
		const outLines: string[] = [];
		let pts: number[] | null = null;
		let remap: Map<number, number> | null = null;
		for (const line of lines) {
			if (line.startsWith('m=')) {
				const fields = line.split(' ');
				pts = fields.slice(3).map(Number).filter((n) => !isNaN(n));
				remap = pts.some((n) => n > 127 || n < 0)
					? new Map(pts.map((n, i) => [n, 96 + i]))
					: null;
				if (remap)
					outLines.push(
						[...fields.slice(0, 3), ...pts.map((n) => remap!.get(n))].join(' ')
					);
				else outLines.push(line);
				continue;
			}
			if (remap && /^(a=rtpmap|a=rtcp-fb|a=fmtp):/.test(line)) {
				const [head, ...rest] = line.split(' ');
				const [attr, ptStr] = head.split(':');
				const n = remap.get(Number(ptStr));
				if (n != null) outLines.push(`${attr}:${n} ${rest.join(' ')}`);
				else outLines.push(line);
				continue;
			}
			if (extGlobal && line.startsWith('a=extmap:')) {
				const m = /^a=extmap:(\d+)((?:\/\w+)?)\s+(\S+.*)$/.exec(line);
				if (m) {
					const gid = extGlobal.get(m[3].split(/\s/)[0]);
					if (gid != null) {
						outLines.push(`a=extmap:${gid}${m[2]} ${m[3]}`);
						continue;
					}
				}
			}
			outLines.push(line);
		}
		return outLines.join('\r\n');
	};
	const sendSdp = (p: Peer, desc: RTCSessionDescription) => {
		send(p, { sid: ourSid, sdp: { type: desc.type, sdp: fixSdp(desc.sdp) } });
	};

	// app frames ride BOTH transports: the 'cic' datachannel when it's open
	// (peer-to-peer, preferred) and the bus as an encrypted `app` payload —
	// the receiver can't tell which transports work on the far side (e.g.
	// WebKitGTK where dc stays 'connecting' forever), so senders always emit
	// the bus copy and receivers dedupe
	const sendAppFrame = async (p: Peer, ns: string, data: unknown) => {
		if (p.dc?.readyState === 'open') {
			try {
				p.dc.send(JSON.stringify({ ns, data }));
			} catch {}
		}
		try {
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const pt = new TextEncoder().encode(JSON.stringify({ ns, data }));
			const ct = await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv },
				await keyP,
				pt
			);
			send(p, { sid: ourSid, app: b64(iv) + '.' + b64(ct) });
		} catch {}
	};

	// dedupe: identical app frames arriving over dc + bus within the window
	const seenApp = new Map<string, number>();
	const dedupeApp = (key: string) => {
		const now = Date.now();
		for (const [k, at] of seenApp) if (now - at > 3000) seenApp.delete(k);
		if (seenApp.has(key)) return true;
		seenApp.set(key, now);
		return false;
	};
	const handleAppFrame = (p: Peer, ns: string, data: unknown) => {
		if (dedupeApp(`${p.sid}|${ns}|${JSON.stringify(data)}`)) return;
		if (ns === SMAP_NS) {
			handleSmap(p, data);
			return;
		}
		actionListeners.get(ns)?.forEach((fn) => fn(data, p.sid));
	};

	// remote told us pool index i carries real published media — adopt that
	// transceiver's receiver track once it can deliver frames (its 'unmute'
	// is the genuine media-arrival signal); 'off' releases the slot so a
	// stopped publish shrinks the seat's stream back down
	const attachTrack = (p: Peer, t: MediaStreamTrack) => {
		if (p.recvStream.getTracks().includes(t)) return;
		p.recvStream.addTrack(t);
		streamListeners.forEach((fn) => fn(p.recvStream, p.sid));
	};
	const adoptTrack = (p: Peer, i: number) => {
		const t = p.pc.getTransceivers()[i]?.receiver?.track;
		if (!t || p.recvSeen.has(t)) return;
		p.recvSeen.add(t);
		if (!t.muted) attachTrack(p, t);
		else t.addEventListener('unmute', () => attachTrack(p, t));
	};
	const handleSmap = (p: Peer, data: unknown) => {
		const f = data as SmapFrame | undefined;
		if (typeof f?.i !== 'number') return;
		if (f.off) {
			p.mapped.delete(f.i);
			const t = p.pc.getTransceivers()[f.i]?.receiver?.track;
			if (t && p.recvStream.getTracks().includes(t)) {
				p.recvStream.removeTrack(t);
				streamListeners.forEach((fn) => fn(p.recvStream, p.sid));
			}
			return;
		}
		p.mapped.add(f.i);
		adoptTrack(p, f.i);
		// drain any receiver arrivals that beat the map frame
		if (p.pendingIdx.delete(f.i)) adoptTrack(p, f.i);
	};

	// every pooled transceiver owns a receiver track from negotiation time —
	// ontrack should fire for each, but some engines defer it until media
	// flows, so sweep the transceiver list on connect as well. Tracks are
	// only adopted once their pool index has been SMAP-mapped by the remote
	// (otherwise padding/keepalive RTP on unclaimed sendrecv slots un-mutes
	// receivers we would mistake for real published media); arrivals before
	// the map lands are parked in pendingIdx
	const collectReceivers = (p: Peer) => {
		p.pc.getTransceivers().forEach((tr, i) => {
			if (!tr.receiver?.track) return;
			if (p.mapped.has(i)) adoptTrack(p, i);
			else p.pendingIdx.add(i);
		});
	};

	const maybeJoin = (p: Peer) => {
		if (p.joined || p.sid.startsWith('pending:')) return;
		// 'joined' = peer is usable for app traffic + media. With bus-relayed
		// app frames the datachannel is a nice-to-have, not the gate — a pc at
		// 'connected' means RTP/ICE/DTLS are up and the bus already proves the
		// peer is alive. dc-open still fires the fast path on healthy runtimes.
		const ready = p.dc?.readyState === 'open' || p.pc.connectionState === 'connected';
		if (!ready) return;
		p.joined = true;
		collectReceivers(p);
		joinListeners.forEach((fn) => fn(p.sid));
	};

	const learnSid = (p: Peer, sid: string) => {
		if (p.sid === sid) return;
		peers.delete(p.sid);
		p.sid = sid;
		peers.set(sid, p);
		maybeJoin(p);
	};

	// this WebKitGTK build crashes the WebProcess outright if pc.close() races
	// an in-flight setLocalDescription/createAnswer — always let any pending
	// local-description op settle first (bounded, in case it never does)
	const safeClose = async (p: Peer) => {
		try {
			await Promise.race([p.pendingLocalOp.catch(() => {}), delay(500)]);
		} catch {}
		try {
			p.dc?.close();
			p.pc.close();
		} catch {}
	};

	// detached pcs are parked here (never closed) — bounded so a flapping
	// peer can't leak unbounded webrtcbin instances
	const abandoned: RTCPeerConnection[] = [];
	const detachPc = (p: Peer) => {
		p.pc.onconnectionstatechange = null;
		p.pc.ondatachannel = null;
		p.pc.onnegotiationneeded = null;
		p.pc.onicecandidate = null;
		p.pc.ontrack = null;
		if (p.dc) {
			p.dc.onopen = null;
			p.dc.onmessage = null;
			p.dc.onclose = null;
			try { p.dc.close(); } catch {}
			p.dc = null;
		}
		abandoned.push(p.pc);
		if (abandoned.length > 32) abandoned.shift();
	};

	const dropPeer = (p: Peer) => {
		peers.delete(p.sid);
		byBusId.delete(p.busId);
		if (alwaysInitiate) {
			// this WebKitGTK build wedges the whole WebProcess in pc.close()
			// — gst_webrtc_bin_change_state joins an rtpsession thread that
			// can be mid-task (or never startable again). Detach + abandon
			// instead of closing: a bounded pc leak beats a dead app.
			detachPc(p);
		} else {
			void safeClose(p);
		}
		if (p.joined) leaveListeners.forEach((fn) => fn(p.sid));
	};

	const wireDc = (p: Peer, dc: RTCDataChannel) => {
		p.dc = dc;
		dc.onopen = () => maybeJoin(p);
		dc.onmessage = (ev) => {
			try {
				const { ns, data } = JSON.parse(String(ev.data)) as { ns: string; data: unknown };
				handleAppFrame(p, ns, data);
			} catch {}
		};
		dc.onclose = () => {
			if (p.pc.connectionState !== 'closed' && p.pc.connectionState !== 'failed') return;
			dropPeer(p);
		};
	};

	const wirePc = (p: Peer) => {
		const pc = p.pc;
		pc.onicecandidate = (ev) => {
			if (ev.candidate) send(p, { sid: ourSid, cand: ev.candidate.toJSON() });
		};
		pc.onnegotiationneeded = () => {
			// initiators fire this exactly once, right after the pool + dc are
			// added — the one-and-only offer this pc will ever make. A second
			// firing would mean something tried to renegotiate (e.g. a stale
			// direction flip); on this WebKitGTK build a second
			// setLocalDescription on a PLAYING webrtcbin deadlocks the whole
			// WebProcess, so it is refused structurally.
			if (!p.initiator || p.offered) return;
			p.makingOffer = true;
			p.pendingLocalOp = pc
				.setLocalDescription()
				.then(() => {
					p.offered = true;
					if (pc.localDescription) sendSdp(p, pc.localDescription);
				})
				.catch(() => {})
				.finally(() => {
					p.makingOffer = false;
				});
		};
		pc.ontrack = (ev) => {
			const i = pc.getTransceivers().findIndex((tr) => tr.receiver.track === ev.track);
			if (i < 0) return;
			if (p.mapped.has(i)) adoptTrack(p, i);
			else p.pendingIdx.add(i);
		};
		pc.onconnectionstatechange = () => {
			if (pc.connectionState === 'connected') maybeJoin(p);
			if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropPeer(p);
		};
		pc.ondatachannel = (ev) => wireDc(p, ev.channel);
	};

	const newPeer = (busId: string, sid: string, initiator: boolean): Peer => {
		const p: Peer = {
			busId, sid, pc: new RTCPeerConnection(rtcConfig),
			dc: null, makingOffer: false, ignoreOffer: false, joined: false,
			pendingLocalOp: Promise.resolve(),
			initiator, offered: false,
			claims: new Map(), mapped: new Set(), pendingIdx: new Set(),
			recvStream: new MediaStream(), recvSeen: new Set(),
			appChain: Promise.resolve()
		};
		peers.set(sid, p);
		byBusId.set(busId, p);
		wirePc(p);
		return p;
	};

	// initiator-side pc setup: the media pool + the 'cic' channel, all before
	// the first (and only) offer. Must be redone if the pc is ever rebuilt.
	const initOfferSide = (p: Peer) => {
		for (let i = 0; i < POOL_AUDIO; i++)
			p.pc.addTransceiver('audio', { direction: 'sendrecv' });
		for (let i = 0; i < POOL_VIDEO; i++)
			p.pc.addTransceiver('video', { direction: 'sendrecv' });
		wireDc(p, p.pc.createDataChannel('cic'));
	};

	// Defense-in-depth: with one-offer-ever semantics the two sides should
	// never collide, but simultaneous joins (each sees the other in
	// welcome.members), stale bus members, or a reconnecting peer can still
	// produce a second offer. Resolving it requires a fresh pc — and this
	// WebKitGTK build can deadlock on setLocalDescription against an
	// already-PLAYING webrtcbin AND crash outright if close() races an
	// in-flight local op that may never settle. So the old pc is never
	// closed: handlers are detached and it is abandoned (ICE never starts
	// on an unanswered offer, so it simply idles). Rare path — a bounded
	// leak beats a hung WebProcess.
	const abandonToAcceptor = (p: Peer) => {
		detachPc(p);
		if (p.joined) leaveListeners.forEach((fn) => fn(p.sid));
		// active local publishes are NOT auto-restored onto the fresh pc — the
		// composite re-offers active streams on peer-join anyway
		p.claims.clear();
		p.mapped.clear();
		p.pendingIdx.clear();
		p.recvStream = new MediaStream();
		p.recvSeen.clear();
		p.dc = null;
		p.joined = false;
		p.makingOffer = false;
		p.offered = false;
		p.pendingLocalOp = Promise.resolve();
		p.initiator = false;
		p.pc = new RTCPeerConnection(rtcConfig);
		wirePc(p);
	};

	const onMsg = async (busId: string, sig: Sig) => {
		// an offer from a peer we don't know yet: always-initiator runtimes
		// answer it with a counter-offer (their engine cannot apply a remote
		// offer at all — the remote's sid tiebreak then makes IT the acceptor);
		// everyone else becomes the acceptor for this pair (see file header)
		let p = findPeer(busId, sig.sid);
		if (!p && sig.sdp?.type === 'offer') {
			p = newPeer(busId, sig.sid, alwaysInitiate);
			if (alwaysInitiate) initOfferSide(p);
		} else if (p && p.busId !== busId) {
			byBusId.delete(p.busId);
			p.busId = busId; // peer rejoined the bus under a new member id
			byBusId.set(busId, p);
		}
		if (!p) return;
		if (sig.sid) learnSid(p, sig.sid);
		if (sig.app) {
			// decrypt+dispatch on a per-peer chain so ordering matches arrival
			const blob = sig.app;
			p.appChain = p.appChain.then(async () => {
				try {
					const [ivB, ctB] = blob.split('.');
					const pt = await crypto.subtle.decrypt(
						{ name: 'AES-GCM', iv: unb64(ivB) },
						await keyP,
						unb64(ctB)
					);
					const { ns, data } = JSON.parse(new TextDecoder().decode(pt)) as {
						ns: string;
						data: unknown;
					};
					handleAppFrame(p, ns, data);
				} catch {}
			});
		}
		let { pc } = p;
		try {
			if (sig.sdp) {
				if (sig.sdp.type === 'offer') {
					if (p.initiator) {
						// both sides offered (simultaneous join, stale member):
						// deterministic winner = larger trystero selfId keeps its
						// offer. The loser abandons its pc (never closes it — see
						// abandonToAcceptor) and answers the winner's offer, so
						// exactly one pair survives. An offer landing on our
						// initiator pc at ANY signaling state must never be
						// answered — a second setLocalDescription on a PLAYING
						// webrtcbin deadlocks the whole WebProcess.
						// always-initiator peers never become the acceptor —
						// their engine can't apply an offer at all, so even a
						// lost tiebreak means ignoring (the pair just doesn't
						// form) rather than wedging on an answer
						if (!alwaysInitiate && sig.sid && sig.sid > ourSid) {
							abandonToAcceptor(p);
							pc = p.pc;
						} else {
							p.ignoreOffer = true;
							return;
						}
					} else if (pc.remoteDescription || pc.signalingState !== 'stable') {
						// a second offer on a pc that already took one — remote
						// violated one-offer-ever (reconnect, stale state). Never
						// answer on a negotiated/pending pc; abandon + fresh
						// acceptor pc.
						abandonToAcceptor(p);
						pc = p.pc;
					}
				} else if (sig.sdp.type === 'answer' && (!p.initiator || !p.offered)) {
					return; // answer we never asked for — protocol violation, drop
				}
				// Firefox numbers extmap ids per m-line; under BUNDLE the same id
				// can map different URIs across m-lines and Chromium then rejects
				// the whole description ("RTP extension ID reassignment not
				// supported") — killing every Cr↔Fx pair. Canonicalize first.
				await p.pc.setRemoteDescription({
					...sig.sdp,
					sdp: normalizeExtmaps(sig.sdp.sdp ?? '')
				});
				if (sig.sdp.type === 'offer') {
					// the offer's pool transceivers arrive here as 'recvonly'
					// (created by setRemoteDescription); flip them to 'sendrecv'
					// before answering so this side may publish later via plain
					// replaceTrack — a local direction set pre-answer needs no
					// renegotiation, but skipping it leaves senders muted forever
					for (const tr of p.pc.getTransceivers()) {
						if (tr.receiver.track && tr.direction === 'recvonly')
							tr.direction = 'sendrecv';
					}
					const localOp = p.pc.setLocalDescription();
					p.pendingLocalOp = localOp.catch(() => {});
					await localOp;
					if (p.pc.localDescription) sendSdp(p, p.pc.localDescription);
				}
			} else if (sig.cand) {
				try {
					await pc.addIceCandidate(sig.cand);
				} catch (e) {
					if (!p.ignoreOffer) throw e;
				}
			}
		} catch (e) {
			console.debug('[ws-room] signal failed', e);
		}
	};

	const offerTo = (busId: string) => {
		// sid unknown until their first reply — key by a pending placeholder,
		// re-keyed by learnSid() when any signaling payload arrives. We created
		// the datachannel, so we are the permanent initiator for this pair.
		const p = newPeer(busId, `pending:${busId}`, true);
		initOfferSide(p); // pool transceivers + dc fire onnegotiationneeded once
	};

	const url = `${busUrl.replace(/^http/, 'ws')}/room/${await roomKey(roomSecret)}`;
	let settled = false;
	const connect = () =>
		new Promise<void>((resolve, reject) => {
			const sock = new WebSocket(`${url}/ws`);
			ws = sock;
			sock.onopen = () => {
				settled = true;
				attempts = 0;
				onBusState?.('up');
				resolve();
			};
			sock.onerror = () => reject(new Error('ws connect failed'));
			sock.onclose = () => {
				// initial connect was rejected by the caller (lane abandoned) —
				// don't keep piling sockets onto the bus
				if (disposed || !settled) {
					disposed = true;
					return;
				}
				onBusState?.('down');
				for (const p of [...peers.values()]) dropPeer(p);
				reconnectTimer = setTimeout(
					() => void connect().catch(() => {}),
					Math.min(1000 * 2 ** attempts++, 15000)
				);
			};
			sock.onmessage = (ev) => {
				let f: BusFrame;
				try {
					f = JSON.parse(String(ev.data));
				} catch {
					return;
				}
				if (f.t === 'welcome' && f.id) {
					myBusId = f.id;
					// stagger offers: when two peers join ~simultaneously each
					// can appear in the other's member list, producing a
					// both-offer collision. A short jitter lets their offer
					// land first and create the acceptor peer below (byBusId
					// check), shrinking the collision window to sub-jitter
					// races — the sid tiebreak in onMsg resolves the rest.
					for (const m of f.members ?? [])
						if (m !== myBusId)
							setTimeout(() => {
								if (!disposed && !byBusId.has(m)) void offerTo(m);
							}, Math.random() * 120);
				} else if (f.t === 'join' && f.id && f.id !== myBusId) {
					// newcomer arrived after our welcome — for always-initiator
					// runtimes we can't wait for their offer (we'd have to
					// answer it to connect), so we initiate ourselves. On other
					// runtimes the newcomer's own offer is the pair-former.
					if (alwaysInitiate)
						setTimeout(() => {
							if (!disposed && !byBusId.has(f.id!)) void offerTo(f.id!);
						}, Math.random() * 120);
				} else if (f.t === 'msg' && f.from && f.data) {
					void onMsg(f.from, f.data);
				} else if (f.t === 'leave' && f.id) {
					const p = findPeer(f.id);
					if (p) dropPeer(p);
				}
			};
		});
	await connect();

	// find a pooled transceiver slot for an outgoing track: kind must match
	// the m-line's, and the slot must be unclaimed and idle. Returns -1 when
	// the pool is full — never fall back to addTrack/renegotiation.
	const claimSlot = (p: Peer, track: MediaStreamTrack): number => {
		const trs = p.pc.getTransceivers();
		for (let i = 0; i < trs.length; i++) {
			const tr = trs[i];
			if (tr.receiver.track?.kind !== track.kind) continue;
			if (tr.sender.track) continue; // occupied (should agree with claims, but trust the pc)
			if ([...p.claims.values()].includes(i)) continue;
			return i;
		}
		return -1;
	};

	const room = {
		makeAction<T>(namespace: string) {
			const sendAction = ((data: T, targets?: string[] | string | null) => {
				const list = targets == null ? [...peers.values()] : targets;
				const arr = Array.isArray(list) ? list : [list];
				for (const t of arr) {
					const p = typeof t === 'string' ? peers.get(t) : (t as Peer);
					if (p) void sendAppFrame(p, namespace, data);
				}
				return Promise.resolve();
			}) as never;
			const on = ((fn: (d: T, p: string) => void) => {
				let set = actionListeners.get(namespace);
				if (!set) actionListeners.set(namespace, (set = new Set()));
				set.add(fn as never);
				return fn;
			}) as never;
			return [sendAction, on, () => {}] as never;
		},
		onPeerJoin: (fn: (id: string) => void) => joinListeners.add(fn),
		onPeerLeave: (fn: (id: string) => void) => leaveListeners.add(fn),
		onPeerStream: (fn: (s: MediaStream, id: string) => void) => streamListeners.add(fn),
		onPeerTrack: () => {},
		// publishing is replaceTrack-into-pool on BOTH roles — identical for
		// initiator and acceptor, and never triggers renegotiation. This is
		// the invariant that keeps WebKitGTK's GstWebRTC alive: one
		// offer/answer per pc, ever.
		addStream: (stream: MediaStream, targets?: string[]) => {
			for (const p of peers.values()) {
				if (targets && !targets.includes(p.sid)) continue;
				for (const t of stream.getTracks()) {
					if (p.claims.has(t)) continue; // already sending this exact track
					const i = claimSlot(p, t);
					if (i < 0) {
						console.debug('[ws-room] transceiver pool exhausted for', t.kind);
						continue;
					}
					p.claims.set(t, i);
					void p.pc.getTransceivers()[i].sender.replaceTrack(t).catch(() => {});
					void sendAppFrame(p, SMAP_NS, { i } as SmapFrame);
				}
			}
		},
		removeStream: (stream: MediaStream) => {
			for (const p of peers.values()) {
				for (const t of stream.getTracks()) {
					const i = p.claims.get(t);
					if (i == null) continue;
					p.claims.delete(t);
					// slot freed for reuse; the remote drops this index from its
					// seat stream (smap off) — and the receiver track mutes on
					// its own anyway once packets stop
					void p.pc.getTransceivers()[i]?.sender.replaceTrack(null).catch(() => {});
					void sendAppFrame(p, SMAP_NS, { i, off: true } as SmapFrame);
				}
			}
		},
		getPeers: () => {
			const out: Record<string, RTCPeerConnection> = {};
			for (const p of peers.values())
				if (!p.sid.startsWith('pending:')) out[p.sid] = p.pc;
			return out;
		},
		// temporary diagnostics: Peer internals (dc state, pool bookkeeping)
		__peerInfo: () =>
			[...peers.values()].map((p) => ({
				sid: p.sid,
				busId: p.busId,
				initiator: p.initiator,
				joined: p.joined,
				dc: p.dc?.readyState ?? null,
				offered: p.offered,
				claims: [...p.claims.values()],
				mapped: [...p.mapped],
				recvTracks: p.recvStream.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.muted ? 'muted' : 'live'}`),
				makingOffer: p.makingOffer
			})),
		leave: async () => {
			disposed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (alwaysInitiate) {
				// never close pcs on this runtime — see dropPeer
				for (const p of [...peers.values()]) detachPc(p);
			} else {
				await Promise.all([...peers.values()].map(safeClose));
			}
			peers.clear();
			ws?.close();
			ws = null;
		},
		ping: async () => 0
	};
	return room as unknown as Room;
}
