/**
 * wsRoom — a Trystero-compatible room facade over the cic-signaling
 * Durable-Object bus. The bus relays opaque {to?, data} frames between room
 * members over one WebSocket; we run the WebRTC handshake ourselves:
 *
 *   newcomer → offer to every established member (welcome.members)
 *   member   → answer on offer; candidates relayed both ways
 *   glare    → lower selfId is polite (rolls back its own offer)
 *
 * App traffic rides a 'cic' datachannel — makeAction namespaces work exactly
 * like Trystero's. Peer ids are announced as `sid` inside signaling payloads
 * so a peer reachable on this lane AND a relay lane merges under the same id.
 *
 * The bus sees only hashed room keys (sha256(secret)) and opaque signaling
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
}
interface Peer {
	busId: string;
	sid: string;
	pc: RTCPeerConnection;
	dc: RTCDataChannel | null;
	makingOffer: boolean;
	ignoreOffer: boolean; // glare: impolite peer ignores remote offer while offering
	joined: boolean; // join listeners fired once dc is open AND the real sid is known
	// this WebKitGTK build crashes the WebProcess outright if close() races an
	// in-flight setLocalDescription/createAnswer — always await this before
	// closing a pc (see rebuildPc)
	pendingLocalOp: Promise<unknown>;
}

async function roomKey(secret: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

	const send = (p: Peer, data: Sig) => {
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ to: p.busId, data }));
	};

	const maybeJoin = (p: Peer) => {
		if (p.joined || p.sid.startsWith('pending:') || p.dc?.readyState !== 'open') return;
		p.joined = true;
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
				actionListeners.get(ns)?.forEach((fn) => fn(data, p.sid));
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
			p.makingOffer = true;
			p.pendingLocalOp = pc
				.setLocalDescription()
				.then(() => {
					if (pc.localDescription) send(p, { sid: selfId, sdp: pc.localDescription });
				})
				.catch(() => {})
				.finally(() => {
					p.makingOffer = false;
				});
		};
		pc.ontrack = (ev) =>
			streamListeners.forEach((fn) => fn(ev.streams[0] ?? new MediaStream([ev.track]), p.sid));
		pc.onconnectionstatechange = () => {
			if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropPeer(p);
		};
		pc.ondatachannel = (ev) => wireDc(p, ev.channel);
	};

	const newPeer = (busId: string, sid: string): Peer => {
		const p: Peer = {
			busId, sid, pc: new RTCPeerConnection(rtcConfig),
			dc: null, makingOffer: false, ignoreOffer: false, joined: false,
			pendingLocalOp: Promise.resolve()
		};
		peers.set(sid, p);
		byBusId.set(busId, p);
		wirePc(p);
		return p;
	};

	// WebKitGTK builds without webrtc rollback support can never revert a stuck
	// local offer — the polite glare path would wedge the pc in have-local-offer
	// forever and remote media never arrives. Rebuild the pc instead: fresh
	// ICE/DTLS/SCTP. The 'cic' datachannel is recreated by the caller AFTER the
	// remote offer is answered — creating it here would fire negotiationneeded
	// and re-glare the fresh pc instantly. Old handlers are detached first so
	// pc.close() doesn't dropPeer() the peer we're about to keep. This
	// WebKitGTK build crashes the whole WebProcess if close() races an
	// in-flight setLocalDescription (e.g. the offer made by offerTo's initial
	// negotiationneeded) — pendingLocalOp is awaited (bounded) before closing.
	// Emit leave+join so the session re-offers published streams to the new pc.
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
		p.dc = null;
		p.joined = false;
		p.makingOffer = false;
		p.pendingLocalOp = Promise.resolve();
		p.pc = new RTCPeerConnection(rtcConfig);
		wirePc(p);
	};

	const onMsg = async (busId: string, sig: Sig) => {
		const polite = selfId < sig.sid; // glare rule: lexicographically lower is polite
		let p = findPeer(busId, sig.sid);
		if (!p && sig.sdp?.type === 'offer') {
			p = newPeer(busId, sig.sid);
		} else if (p && p.busId !== busId) {
			byBusId.delete(p.busId);
			p.busId = busId; // peer rejoined the bus under a new member id
			byBusId.set(busId, p);
		}
		if (!p) return;
		if (sig.sid) learnSid(p, sig.sid);
		const { pc } = p;
		try {
			if (sig.sdp) {
				const offerCollision =
					sig.sdp.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
				p.ignoreOffer = !polite && offerCollision;
				if (p.ignoreOffer) return;
				let rebuilt = false;
				if (offerCollision) {
					try {
						await pc.setLocalDescription({ type: 'rollback' });
					} catch {
						await rebuildPc(p);
						rebuilt = true;
					}
				}
				await p.pc.setRemoteDescription(sig.sdp);
				if (sig.sdp.type === 'offer') {
					const localOp = p.pc.setLocalDescription();
					p.pendingLocalOp = localOp.catch(() => {});
					await localOp;
					if (p.pc.localDescription) send(p, { sid: selfId, sdp: p.pc.localDescription });
					// fresh pc needs our 'cic' channel — create it only now that the
					// remote offer is answered (early creation would re-glare)
					if (rebuilt) wireDc(p, p.pc.createDataChannel('cic'));
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
		// re-keyed by learnSid() when any signaling payload arrives
		const p = newPeer(busId, `pending:${busId}`);
		wireDc(p, p.pc.createDataChannel('cic'));
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

	const room = {
		makeAction<T>(namespace: string) {
			const sendAction = ((data: T, targets?: string[] | string | null) => {
				const frame = JSON.stringify({ ns: namespace, data });
				const list = targets == null ? [...peers.values()] : targets;
				const arr = Array.isArray(list) ? list : [list];
				for (const t of arr) {
					const p = typeof t === 'string' ? peers.get(t) : (t as Peer);
					if (p?.dc?.readyState === 'open') p.dc.send(frame);
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
		addStream: (stream: MediaStream, targets?: string[]) => {
			for (const p of peers.values()) {
				if (targets && !targets.includes(p.sid)) continue;
				for (const t of stream.getTracks())
					if (!p.pc.getSenders().some((s) => s.track === t)) p.pc.addTrack(t, stream);
			}
		},
		removeStream: (stream: MediaStream) => {
			for (const p of peers.values())
				for (const s of p.pc.getSenders())
					if (s.track && stream.getTracks().includes(s.track)) p.pc.removeTrack(s);
		},
		getPeers: () => {
			const out: Record<string, RTCPeerConnection> = {};
			for (const p of peers.values())
				if (!p.sid.startsWith('pending:')) out[p.sid] = p.pc;
			return out;
		},
		leave: async () => {
			disposed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			for (const p of [...peers.values()]) {
				try {
					p.pc.close();
				} catch {}
			}
			peers.clear();
			ws?.close();
			ws = null;
		},
		ping: async () => 0
	};
	return room as unknown as Room;
}
