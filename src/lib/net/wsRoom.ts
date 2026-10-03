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
 */
import { selfId } from 'trystero/mqtt';
import type { Room } from 'trystero';

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
	rtcConfig: RTCConfiguration
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

	const send = (p: Peer, data: Sig) => {
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ to: p.busId, data }));
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
			send(p, { sid: selfId, app: b64(iv) + '.' + b64(ct) });
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
		actionListeners.get(ns)?.forEach((fn) => fn(data, p.sid));
	};

	// adopt a remote receiver track into the peer's merged stream the first
	// time it can actually produce media — before that it is a muted
	// negotiation placeholder, and publishing it early would render a black
	// seat for a peer who never sent anything
	const adoptTrack = (p: Peer, t: MediaStreamTrack) => {
		if (p.recvSeen.has(t)) return;
		p.recvSeen.add(t);
		const attach = () => {
			if (p.recvStream.getTracks().includes(t)) return;
			p.recvStream.addTrack(t);
			streamListeners.forEach((fn) => fn(p.recvStream, p.sid));
		};
		if (!t.muted) attach();
		else t.addEventListener('unmute', attach);
	};
	// every pooled transceiver owns a receiver track from negotiation time —
	// ontrack should fire for each, but some engines defer it until media
	// flows, so sweep the transceiver list on connect as well
	const collectReceivers = (p: Peer) => {
		for (const tr of p.pc.getTransceivers()) {
			const t = tr.receiver?.track;
			if (t) adoptTrack(p, t);
		}
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

	const dropPeer = (p: Peer) => {
		peers.delete(p.sid);
		byBusId.delete(p.busId);
		void safeClose(p);
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
			if (ev.candidate) send(p, { sid: selfId, cand: ev.candidate.toJSON() });
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
					if (pc.localDescription) send(p, { sid: selfId, sdp: pc.localDescription });
				})
				.catch(() => {})
				.finally(() => {
					p.makingOffer = false;
				});
		};
		pc.ontrack = (ev) => adoptTrack(p, ev.track);
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
			claims: new Map(), recvStream: new MediaStream(), recvSeen: new Set(),
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

	// Defense-in-depth only: with one-offer-ever semantics the two sides
	// should never collide, so this path is not expected to trigger in normal
	// operation. Kept in case a bug, a stale peer from before a reconnect, or
	// a future code path reintroduces a collision — WebKitGTK builds without
	// rollback support can otherwise wedge the pc in have-local-offer
	// forever. Rebuild instead: fresh ICE/DTLS/SCTP, preserving the peer's
	// role. Old handlers are detached first so pc.close() doesn't dropPeer()
	// the peer we're about to keep, and this WebKitGTK build crashes the
	// whole WebProcess if close() races an in-flight setLocalDescription —
	// pendingLocalOp is awaited (bounded) before closing.
	const rebuildPc = async (p: Peer) => {
		const old = p.pc;
		const oldDc = p.dc;
		old.onconnectionstatechange = null;
		old.ondatachannel = null;
		old.onnegotiationneeded = null;
		old.onicecandidate = null;
		old.ontrack = null;
		try {
			await Promise.race([p.pendingLocalOp.catch(() => {}), delay(500)]);
		} catch {}
		try { oldDc?.close(); } catch {}
		try { old.close(); } catch {}
		if (p.joined) leaveListeners.forEach((fn) => fn(p.sid));
		// active local publishes are NOT auto-restored onto the fresh pc — the
		// composite re-offers active streams on peer-join anyway
		p.claims.clear();
		p.recvStream = new MediaStream();
		p.recvSeen.clear();
		p.dc = null;
		p.joined = false;
		p.makingOffer = false;
		p.offered = false;
		p.pendingLocalOp = Promise.resolve();
		p.pc = new RTCPeerConnection(rtcConfig);
		wirePc(p);
		if (p.initiator) initOfferSide(p); // fresh pc needs its pool + dc + offer
	};

	const onMsg = async (busId: string, sig: Sig) => {
		// an offer from a peer we don't know yet means we never contacted them —
		// we're the acceptor for this pair (see file header)
		let p = findPeer(busId, sig.sid);
		if (!p && sig.sdp?.type === 'offer') {
			p = newPeer(busId, sig.sid, false);
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
		const { pc } = p;
		try {
			if (sig.sdp) {
				// a remote offer while we're non-stable means the other side
				// offered a second time — impossible under one-offer-ever
				// semantics, so treat as corruption and rebuild. Acceptor on a
				// fresh/stable pc is the only legitimate offer-taker.
				const offerCollision =
					sig.sdp.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
				p.ignoreOffer = p.initiator && offerCollision;
				if (p.ignoreOffer) return;
				if (offerCollision) {
					try {
						await pc.setLocalDescription({ type: 'rollback' });
					} catch {
						await rebuildPc(p);
					}
				}
				await p.pc.setRemoteDescription(sig.sdp);
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
					if (p.pc.localDescription) send(p, { sid: selfId, sdp: p.pc.localDescription });
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
					for (const m of f.members ?? []) if (m !== myBusId) void offerTo(m);
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
				}
			}
		},
		removeStream: (stream: MediaStream) => {
			for (const p of peers.values()) {
				for (const t of stream.getTracks()) {
					const i = p.claims.get(t);
					if (i == null) continue;
					p.claims.delete(t);
					// slot stays reserved-for-nothing — freed for reuse; the remote
					// receiver track mutes rather than ends, which reads as
					// "stopped sending" without tearing down the stream object
					void p.pc.getTransceivers()[i]?.sender.replaceTrack(null).catch(() => {});
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
				recvTracks: p.recvStream.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.muted ? 'muted' : 'live'}`),
				makingOffer: p.makingOffer
			})),
		leave: async () => {
			disposed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			await Promise.all([...peers.values()].map(safeClose));
			peers.clear();
			ws?.close();
			ws = null;
		},
		ping: async () => 0
	};
	return room as unknown as Room;
}
