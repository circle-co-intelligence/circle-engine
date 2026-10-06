// Multi-lane Trystero transport — the entire networking surface.
//
// Lanes (env: VITE_CIC_LANES, default 'mqtt'): mqtt | nostr | torrent | ipfs
// | supabase | ws. 'ws' uses our own Durable-Object bus (VITE_CIC_SIGNAL_WS —
// the cic-signaling worker); the rest are trystero strategies. Each lane is an
// independent joinRoom on the same roomSecret and
// shared selfId; peers reachable on ANY lane are merged into one view, so a
// broker/relay outage on one lane doesn't break the circle. Ops are deduped
// by opId; identical realtime frames arriving on multiple lanes within a
// short window are deduped too.
//
// Lanes connect asynchronously (dynamic imports + /api/ice fetch); sends made
// before the first lane is ready are queued and flushed on connect.
//
// TURN/STUN come from VITE_CIC_TURN (JSON iceServers array) and/or the
// /api/ice endpoint (short-lived credentials from the edge worker).
import { joinRoom as joinMqtt, selfId } from 'trystero/mqtt';
import { backOff } from 'exponential-backoff';
import { opEnvelope, realtimeMessage, type OpEnvelope, type RealtimeMessage } from '../wire/messages';
import { installSimulcast } from '../media/simulcast';
import type { DataPayload, Room } from 'trystero';

// mesh simulcast: upgrade pc.addTrack → rid-layered transceivers on every
// lane pc (trystero + ws). Module-level so the patch precedes joinRoom.
installSimulcast();

export interface RoomHandle {
	selfId: string;
	sendOp: (env: OpEnvelope) => void;
	sendRealtime: (msg: RealtimeMessage, to?: string) => void;
	onOp: (fn: (env: OpEnvelope, peerId: string) => void) => void;
	onRealtime: (fn: (msg: RealtimeMessage, peerId: string) => void) => void;
	makeAction: Room['makeAction'];
	onPeerJoin: (fn: (peerId: string) => void) => void;
	onPeerLeave: (fn: (peerId: string) => void) => void;
	onPeerStream: (fn: (stream: MediaStream, peerId: string) => void) => void;
	/**
	 * Remote tagged a published slot (e.g. 'milo') — fires with a stream
	 * holding ONLY that tag's tracks so synthetic sources are separately
	 * addressable. Lanes without SMAP tag support never fire this; the
	 * track just merges into the seat's normal stream (still audible).
	 */
	onPeerTaggedStream: (fn: (stream: MediaStream, peerId: string, tag: string) => void) => void;
	addStream: (stream: MediaStream, targets?: string[], tag?: string) => void;
	removeStream: (stream: MediaStream) => void;
	leave: () => Promise<void>;
	raw: Room;
	/** per-peer ICE state, merged across lanes */
	peerConnState: (peerId: string) => string;
	/** subscribe to merged per-peer ICE state changes */
	onPeerConn: (fn: (peerId: string, state: string) => void) => void;
	/** signaling-plane state: 'up' once a lane attaches, 'down' if every lane failed */
	onSignal: (fn: (state: 'connecting' | 'up' | 'down') => void) => void;
	/** ws-lane bus socket state — 'down' while the reconnect loop cycles */
	onBus: (fn: (state: 'up' | 'down') => void) => void;
	/** ICE-restart every peer connection (network flap / resume) */
	restartAll: () => void;
	/** resolves when the first lane is connected */
	ready: Promise<void>;
	/** resolved ICE server list (STUN + any TURN from env/broker) */
	iceServers: () => Promise<RTCIceServer[]>;
	/** debug: per-lane peer pcs + lane membership (temporary diagnostics) */
	__laneDebug?: () => Record<string, unknown>;
	/**
	 * Session policy: may this peer currently receive our published streams?
	 * Consulted on every offer path (merged-join replay, lane-attach replay,
	 * session offer) so password-unverified/held/denied joiners can never be
	 * offered member media — regardless of which path would push it.
	 */
	offerGate?: (peerId: string) => boolean;
}

/** trystero's onPeer* setters are last-write-wins — wrap them as additive sets */
function mkListenerSet<A extends unknown[]>(set: (fn: (...args: A) => void) => void) {
	const listeners = new Set<(...args: A) => void>();
	set((...args: A) => listeners.forEach((fn) => fn(...args)));
	return (fn: (...args: A) => void) => {
		listeners.add(fn);
	};
}

type LaneName = 'mqtt' | 'nostr' | 'torrent' | 'ipfs' | 'supabase' | 'ws';
// wsRoom's addStream accepts a slot tag ('milo'); trystero lanes ignore the
// extra arg — the track just merges into the seat's stream there
type TaggedAdd = (stream: MediaStream, targets?: string[], tag?: string) => void;

const env = import.meta.env as Record<string, string | undefined>;
const trysteroConfig = { appId: 'co-intelligence-circle' };

function laneList(): LaneName[] {
	const raw = env.VITE_CIC_LANES ?? 'mqtt';
	return raw
		.split(',')
		.map((s) => s.trim())
		.filter((s): s is LaneName =>
			['mqtt', 'nostr', 'torrent', 'ipfs', 'supabase', 'ws'].includes(s)
		);
}

async function joinLane(
	lane: LaneName,
	secret: string,
	rtcConfig: RTCConfiguration,
	onBusState?: (state: 'up' | 'down') => void
): Promise<Room | null> {
	try {
		switch (lane) {
			case 'mqtt': {
				const brokerCsv = env.VITE_CIC_MQTT_BROKERS;
				return joinMqtt(
					{ ...trysteroConfig, rtcConfig, ...(brokerCsv ? { relayUrls: brokerCsv.split(',') } : {}) },
					secret
				);
			}
			case 'nostr': {
				const { joinRoom } = await import('trystero/nostr');
				const relays = env.VITE_CIC_NOSTR_RELAYS;
				return joinRoom(
					{ ...trysteroConfig, rtcConfig, ...(relays ? { relayUrls: relays.split(',') } : {}) },
					secret
				);
			}
			case 'torrent': {
				const { joinRoom } = await import('trystero/torrent');
				return joinRoom({ ...trysteroConfig, rtcConfig }, secret);
			}
			case 'ipfs': {
				const { joinRoom } = await import('trystero/ipfs');
				return joinRoom({ ...trysteroConfig, rtcConfig }, secret);
			}
			case 'ws': {
				// our DO-backed bus — '/sig' on CF Pages deploys (VITE_CIC_SIGNAL_WS
				// may be a path or a full URL; a path resolves to same-origin)
				let bus = env.VITE_CIC_SIGNAL_WS;
				if (bus?.startsWith('/') && typeof location !== 'undefined')
					bus = `${location.origin}${bus}`;
				if (!bus) return null;
				const { openWsRoom } = await import('./wsRoom');
				return openWsRoom(bus, secret, rtcConfig, onBusState);
			}
			case 'supabase': {
				const url = env.VITE_CIC_SUPABASE_URL;
				const key = env.VITE_CIC_SUPABASE_KEY;
				if (!url || !key) return null;
				const { joinRoom } = await import('trystero/supabase');
				// supabase strategy uses appId as the project URL
				return joinRoom({ appId: url, supabaseKey: key, rtcConfig } as never, secret) as unknown as Room;
			}
		}
	} catch (e) {
		console.warn(`[net] lane ${lane} unavailable:`, e);
		return null;
	}
}

// ICE credentials are room-scoped — TURN is a paid lane gated on the room's
// funded pool (/api/ice returns STUN-only when unpaid), so results are
// cached per room code and re-resolved on expiry/top-up
let iceCache = new Map<string, Promise<RTCConfiguration>>();
export function iceServers(room = ''): Promise<RTCConfiguration> {
	let p = iceCache.get(room);
	if (!p) iceCache.set(room, (p = fetchIceServers(room)));
	return p;
}
/** force re-resolve (credential expiry, broker change, post-top-up) */
export function refreshIceServers(room = ''): Promise<RTCConfiguration> {
	iceCache.delete(room);
	return iceServers(room);
}

/** the broker's reason for omitting TURN — 'topup' means the room pool is
 *  empty and relayed media is unavailable until it's credited */
export let lastIceReason: string | null = null;

/** fetch short-lived ICE servers from the edge broker; STUN fallback always present */
async function fetchIceServers(room = ''): Promise<RTCConfiguration> {
	const iceServers: RTCIceServer[] = [
		{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }
	];
	const envTurn = env.VITE_CIC_TURN;
	if (envTurn) {
		try {
			iceServers.push(...(JSON.parse(envTurn) as RTCIceServer[]));
		} catch {
			console.warn('[net] VITE_CIC_TURN is not valid JSON iceServers');
		}
	}
	try {
		const res = await fetch(`/api/ice${room ? `?room=${encodeURIComponent(room)}` : ''}`, {
			signal: AbortSignal.timeout(1800)
		});
		if (res.ok) {
			const body = (await res.json()) as { iceServers?: RTCIceServer[]; reason?: string };
			lastIceReason = body.reason ?? null;
			if (body.iceServers?.length) iceServers.push(...body.iceServers);
		}
	} catch {
		// no broker configured — STUN/env only
	}
	// libnice (WebKitGTK's ICE backend) aborts on an assertion once an agent
	// exceeds NICE_CANDIDATE_MAX_TURN_SERVERS — the broker returns 6
	// turn/turns URLs, which kills the native WebProcess mid-gather.
	// Chromium tolerates the full set; cap only on the Tauri shell.
	const native = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
	return {
		iceServers: native ? limitTurnUrls(iceServers, 3) : iceServers,
		bundlePolicy: 'max-bundle'
	};
}

/**
 * Keep at most `max` turn:/turns: URLs across the whole list, covering the
 * three failure modes first — turns: (TLS), turn:?transport=udp,
 * turn:?transport=tcp — then filling the remaining budget by port
 * reachability (443/80 before high ports). STUN entries are untouched;
 * the same credentials keep covering the kept URLs.
 */
export function limitTurnUrls(servers: RTCIceServer[], max = 3): RTCIceServer[] {
	const all: string[] = [];
	for (const s of servers)
		for (const u of Array.isArray(s.urls) ? s.urls : [s.urls])
			if (/^turns?:/.test(u) && !all.includes(u)) all.push(u);
	if (all.length <= max) return servers;
	const portRank = (u: string): number => {
		const port = Number(/:(\d+)/.exec(u)?.[1] ?? 0);
		return port === 443 ? 0 : port === 80 ? 1 : port === 3478 ? 2 : 3;
	};
	const kind = (u: string): number =>
		u.startsWith('turns:') ? 0 : u.includes('transport=udp') ? 1 : 2;
	const kept = new Set<string>();
	// one of each transport family first, in family order
	for (const k of [0, 1, 2]) {
		const best = all.filter((u) => kind(u) === k).sort((a, b) => portRank(a) - portRank(b))[0];
		if (best && kept.size < max) kept.add(best);
	}
	// fill remaining budget by port reachability
	for (const u of [...all].sort((a, b) => portRank(a) - portRank(b) || kind(a) - kind(b))) {
		if (kept.size >= max) break;
		kept.add(u);
	}
	return servers
		.map((s) => {
			const wasArray = Array.isArray(s.urls);
			const urls = wasArray ? (s.urls as string[]) : [s.urls as string];
			const filtered = urls.filter((u) => !/^turns?:/.test(u) || kept.has(u));
			return { ...s, urls: wasArray ? filtered : filtered[0] };
		})
		.filter((s) => (Array.isArray(s.urls) ? s.urls.length > 0 : Boolean(s.urls)));
}

interface Lane {
	name: LaneName;
	room: Room;
	sendOp: (env: OpEnvelope, to?: string[] | null) => unknown;
	sendRt: (msg: RealtimeMessage, to?: string | string[] | null) => unknown;
	onJoin: (fn: (peerId: string) => void) => void;
	onLeave: (fn: (peerId: string) => void) => void;
	onStream: (fn: (stream: MediaStream, peerId: string) => void) => void;
	iceStates: Map<string, string>;
}

export function openRoom(roomSecret: string, opts?: { roomCode?: string }): RoomHandle {
	// the room code scopes paid-lane lookups (TURN credential funding)
	const roomCode = opts?.roomCode ?? '';
	// shared listener sets — registered before/after lanes connect alike
	const laneOfPeer = new Map<string, Set<Lane>>();
	const lanes: Lane[] = [];
	const joinListeners = new Set<(peerId: string) => void>();
	const leaveListeners = new Set<(peerId: string) => void>();
	const streamListeners = new Set<(stream: MediaStream, peerId: string) => void>();
	const connStateListeners = new Set<(peerId: string, state: string) => void>();
	const taggedListeners = new Set<(stream: MediaStream, peerId: string, tag: string) => void>();
	const signalListeners = new Set<(state: 'connecting' | 'up' | 'down') => void>();
	const busListeners = new Set<(state: 'up' | 'down') => void>();
	let signalState: 'connecting' | 'up' | 'down' = 'connecting';
	const emitSignal = (state: typeof signalState) => {
		if (signalState === state) return;
		signalState = state;
		signalListeners.forEach((fn) => fn(state));
	};
	const emitBus = (state: 'up' | 'down') => busListeners.forEach((fn) => fn(state));
	const opListeners = new Set<(env: OpEnvelope, peerId: string) => void>();
	const rtListeners = new Set<(msg: RealtimeMessage, peerId: string) => void>();
	// custom actions (notes sync etc.) — namespace → listeners; lane receivers
	// wire into these when the lane connects
	const actionListeners = new Map<string, Set<(data: unknown, peerId: string) => void>>();
	const pendingOps: OpEnvelope[] = [];
	const pendingRt: { msg: RealtimeMessage; to?: string }[] = [];
	const pendingStreams: { stream: MediaStream; targets?: string[]; tag?: string }[] = [];
	// streams currently requested of the mesh — re-applied to lanes that
	// connect late (retry path) so late-joining lanes aren't media-blind
	const activeStreams: { stream: MediaStream; targets?: string[]; tag?: string }[] = [];
	// per-lane stream offers (lane → peerId → stream ids). A stream must reach
	// every lane that sees the peer, not just whichever lane fired the merged
	// join first — dedupe keeps repeated offers (rejoin, re-publish, both
	// session offerStream and lane-join replay) from double-adding tracks
	const laneOffers = new Map<Lane, Map<string, Set<string>>>();
	const markOffered = (lane: Lane, peerId: string, stream: MediaStream): boolean => {
		let m = laneOffers.get(lane);
		if (!m) laneOffers.set(lane, (m = new Map()));
		let s = m.get(peerId);
		if (!s) m.set(peerId, (s = new Set()));
		if (s.has(stream.id)) return false;
		s.add(stream.id);
		return true;
	};
	// session-settable gate — consulted on EVERY offer path so a joiner the
	// session hasn't verified yet (password proof pending) can never receive
	// member media, no matter which path would push it
	let offerGate: RoomHandle['offerGate'];
	const offerToPeer = (lane: Lane, peerId: string) => {
		if (offerGate && !offerGate(peerId)) return;
		for (const { stream, targets, tag } of activeStreams) {
			if (targets && !targets.includes(peerId)) continue;
			if (!markOffered(lane, peerId, stream)) continue;
			try {
				(lane.room.addStream as TaggedAdd)(stream, [peerId], tag);
			} catch {
				/* already negotiated on this lane's pc */
			}
		}
	};
	let connected = false;

	// dedupe: ops carry opId; realtime frames dedupe identical content within
	// a 600ms window (lane duplication arrives ~simultaneously; legit repeats
	// like heartbeats arrive seconds apart)
	const seenOps = new Set<string>();
	const seenRt = new Map<string, number>();
	const dedupeRt = (key: string) => {
		const now = Date.now();
		for (const [k, at] of seenRt) if (now - at > 600) seenRt.delete(k);
		if (seenRt.has(key)) return true;
		seenRt.set(key, now);
		return false;
	};

	const wireLane = (lane: Lane) => {
		lanes.push(lane);
		// ICE repair + per-peer connectivity tracking — restarts back off
		// exponentially per connection so a hard-failed path doesn't spin
		lane.onJoin((peerId) => {
			const pc = lane.room.getPeers()[peerId];
			if (!pc) return;
			let restarts = 0;
			let timer: ReturnType<typeof setTimeout> | undefined;
			pc.addEventListener('iceconnectionstatechange', () => {
				const st = pc.iceConnectionState;
				lane.iceStates.set(peerId, st);
				connStateListeners.forEach((fn) => fn(peerId, st));
				if (st === 'connected' || st === 'completed') {
					restarts = 0;
					clearTimeout(timer);
					return;
				}
				if (st !== 'failed' && st !== 'disconnected') return;
				if (timer) return;
				const delay = st === 'failed' ? 0 : Math.min(1000 * 2 ** restarts, 15000);
				timer = setTimeout(() => {
					timer = undefined;
					if (pc.connectionState === 'closed') return;
					restarts++;
					console.debug('[net] ICE restart', peerId.slice(0, 8), `#${restarts}`);
					pc.restartIce();
				}, delay);
			});
		});
		// merged membership: join once, leave only when no lane holds the peer
		lane.onJoin((peerId) => {
			const set = laneOfPeer.get(peerId) ?? new Set();
			const first = set.size === 0;
			set.add(lane);
			laneOfPeer.set(peerId, set);
			// a lane that joins the peer after the merged join already fired still
			// needs the active streams — the session-level offer at merged-join
			// time only reached whichever lane reported first
			offerToPeer(lane, peerId);
			if (first) joinListeners.forEach((fn) => fn(peerId));
		});
		lane.onLeave((peerId) => {
			const set = laneOfPeer.get(peerId);
			if (!set) return;
			set.delete(lane);
			lane.iceStates.delete(peerId);
			laneOffers.get(lane)?.delete(peerId);
			if (set.size === 0) {
				laneOfPeer.delete(peerId);
				leaveListeners.forEach((fn) => fn(peerId));
			}
		});
		lane.onStream((stream, peerId) => streamListeners.forEach((fn) => fn(stream, peerId)));
		// wsRoom lanes can tag published slots ('milo') → receivers route them
		// to a dedicated stream; trystero lanes lack the concept (merge only)
		(lane.room as { onPeerTaggedStream?: (fn: (s: MediaStream, p: string, tag: string) => void) => void })
			.onPeerTaggedStream?.((stream, peerId, tag) =>
				taggedListeners.forEach((fn) => fn(stream, peerId, tag))
			);

		const [, onOp] = lane.room.makeAction<OpEnvelope>('op');
		const [, onRt] = lane.room.makeAction<RealtimeMessage>('rt');
		onOp((env, peerId) => {
			if (seenOps.has(env.opId)) return;
			seenOps.add(env.opId);
			if (seenOps.size > 8192) seenOps.clear();
			opListeners.forEach((fn) => fn(env, peerId));
		});
		onRt((msg, peerId) => {
			if (dedupeRt(`${peerId}:${JSON.stringify(msg)}`)) return;
			rtListeners.forEach((fn) => fn(msg, peerId));
		});
		// custom-action receivers registered before this lane connected
		for (const [ns, listeners] of actionListeners) {
			const [, on] = lane.room.makeAction(ns);
			on((d, p) => listeners.forEach((fn) => fn(d, p)));
		}
	};

	const sendOpAll = (env: OpEnvelope) => {
		for (const lane of lanes) void lane.sendOp(env, null);
	};
	const sendRtTo = (msg: RealtimeMessage, to?: string) => {
		if (to) {
			const set = laneOfPeer.get(to);
			if (set?.size) {
				for (const lane of set) void lane.sendRt(msg, to);
				return;
			}
		}
		for (const lane of lanes) void lane.sendRt(msg, to ?? null);
	};

	const restartAll = () => {
		for (const lane of lanes)
			for (const pc of Object.values(lane.room.getPeers())) {
				try {
					pc.restartIce();
				} catch {
					/* pc closed */
				}
			}
	};
	if (typeof document !== 'undefined') {
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible') restartAll();
		});
		window.addEventListener('online', restartAll);
	}

	const applyStreams = (lane: Lane) => {
		for (const { stream, targets, tag } of activeStreams) {
			const here = (targets
				? targets.filter((t) => laneOfPeer.get(t)?.has(lane))
				: Object.keys(lane.room.getPeers())
			).filter((pid) => !offerGate || offerGate(pid));
			const fresh = here.filter((pid) => markOffered(lane, pid, stream));
			if (!fresh.length) continue;
			try {
				(lane.room.addStream as TaggedAdd)(stream, fresh, tag);
			} catch {
				/* already negotiated on this lane's pc */
			}
		}
	};

	// a lane that fails at boot (relay down, worker cold-start) retried in the
	// background and wired in when it finally connects — MultiRoom degrades
	// instead of dying on one lane's outage
	const attach = (name: LaneName, room: Room) => {
		const [sendOp] = room.makeAction<OpEnvelope>('op') as unknown as [Lane['sendOp']];
		const [sendRt] = room.makeAction<RealtimeMessage>('rt') as unknown as [Lane['sendRt']];
		const lane: Lane = {
			name,
			room,
			sendOp,
			sendRt,
			onJoin: mkListenerSet(room.onPeerJoin),
			onLeave: mkListenerSet(room.onPeerLeave),
			onStream: mkListenerSet(room.onPeerStream),
			iceStates: new Map()
		};
		wireLane(lane);
		applyStreams(lane);
	};

	const flushPending = () => {
		for (const env of pendingOps.splice(0)) sendOpAll(env);
		for (const { msg, to } of pendingRt.splice(0)) sendRtTo(msg, to);
		for (const s of pendingStreams.splice(0)) activeStreams.push(s);
	};

	const LANE_RETRIES = 6;
	// first successful attach unblocks sends; the rest keep retrying in the
	// background and join the composite whenever they connect
	const joinWithRetry = async (name: LaneName, rtcConfig: RTCConfiguration): Promise<boolean> => {
		try {
			return await backOff(
				async () => {
					const room = await joinLane(
						name,
						roomSecret,
						rtcConfig,
						name === 'ws' ? emitBus : undefined
					).catch(() => null);
					if (!room) throw new Error('lane unavailable');
					attach(name, room);
					if (!connected) {
						connected = true;
						emitSignal('up');
						flushPending();
					}
					return true;
				},
				{ numOfAttempts: LANE_RETRIES, startingDelay: 1000, maxDelay: 15000 }
			);
		} catch {
			console.warn(`[net] lane ${name} gave up after ${LANE_RETRIES} attempts`);
			return false;
		}
	};

	const ready = (async () => {
		const rtcConfig = await iceServers(roomCode);
		await Promise.all(laneList().map((name) => joinWithRetry(name, rtcConfig)));
		if (!lanes.length) {
			emitSignal('down');
			throw new Error('no signaling lanes available');
		}
	})();
	// the rejection is reported via onSignal — mark handled so an unattached
	// consumer doesn't get an unhandled-rejection noise event
	ready.catch(() => {});

	// composite room exposing merged peer connections (E2EE attach, ICE repair)
	const compositeRoom = {
		getPeers: () => {
			const out: Record<string, RTCPeerConnection> = {};
			for (const lane of lanes) Object.assign(out, lane.room.getPeers());
			return out;
		},
		leave: () => Promise.all(lanes.map((l) => l.room.leave())).then(() => {})
	} as unknown as Room;

	const handle: RoomHandle = {
		selfId,
		sendOp(env) {
			const parsed = opEnvelope.parse(env);
			if (!connected) {
				pendingOps.push(parsed);
				return;
			}
			sendOpAll(parsed);
		},
		sendRealtime(msg, to) {
			const parsed = realtimeMessage.parse(msg);
			if (!connected) {
				pendingRt.push({ msg: parsed, to });
				return;
			}
			sendRtTo(parsed, to);
		},
		onOp: (fn) => {
			opListeners.add(fn);
		},
		onRealtime: (fn) => {
			rtListeners.add(fn);
		},
		// custom namespaces (notes sync, breakouts): broadcast on every lane,
		// receivers merged — registered now, wired when each lane connects
		makeAction: (<T extends DataPayload>(namespace: string) => {
			let listeners = actionListeners.get(namespace) as Set<(d: T, p: string) => void> | undefined;
			if (!listeners) {
				listeners = new Set();
				actionListeners.set(namespace, listeners as never);
			}
			const listenersRef = listeners;
			const send = (data: T, targets?: string | string[] | null) => {
				if (!connected) return Promise.resolve() as never;
				return Promise.all(
					lanes.map((l) => l.room.makeAction<T>(namespace)[0](data, targets ?? null))
				) as never;
			};
			const on = (fn: (d: T, p: string) => void) => {
				listenersRef.add(fn);
				return fn as never;
			};
			return [send, on, () => {}] as never;
		}) as Room['makeAction'],
		onPeerJoin: (fn) => joinListeners.add(fn),
		onPeerLeave: (fn) => leaveListeners.add(fn),
		onPeerStream: (fn) => streamListeners.add(fn),
		onPeerTaggedStream: (fn) => taggedListeners.add(fn),
		get offerGate() {
			return offerGate;
		},
		set offerGate(fn: RoomHandle['offerGate']) {
			offerGate = fn;
		},
		addStream: (stream, targets, tag) => {
			if (!connected) {
				pendingStreams.push({ stream, targets, tag });
				return;
			}
			activeStreams.push({ stream, targets, tag });
			for (const lane of lanes) {
				const here = (targets
					? targets.filter((t) => laneOfPeer.get(t)?.has(lane))
					: Object.keys(lane.room.getPeers())
				).filter((pid) => !offerGate || offerGate(pid));
				const fresh = here.filter((pid) => markOffered(lane, pid, stream));
				if (!fresh.length) continue;
				try {
					(lane.room.addStream as TaggedAdd)(stream, fresh, tag);
				} catch {
					/* already negotiated on this lane's pc */
				}
			}
		},
		removeStream: (stream) => {
			const i = activeStreams.findIndex((s) => s.stream === stream);
			if (i >= 0) activeStreams.splice(i, 1);
			for (const m of laneOffers.values()) for (const s of m.values()) s.delete(stream.id);
			lanes.forEach((l) => l.room.removeStream(stream));
		},
		leave: () => compositeRoom.leave(),
		raw: compositeRoom,
		peerConnState: (peerId) => {
			for (const lane of lanes) {
				const st = lane.iceStates.get(peerId);
				if (st) return st;
			}
			return 'new';
		},
		onPeerConn: (fn) => {
			connStateListeners.add(fn);
		},
		onSignal: (fn) => {
			signalListeners.add(fn);
			fn(signalState);
		},
		onBus: (fn) => {
			busListeners.add(fn);
		},
		restartAll,
		ready,
		iceServers: async () => (await iceServers(roomCode)).iceServers ?? [],
		__laneDebug: () => {
			const out: Record<string, unknown> = { lanes: {}, laneOfPeer: {} };
			for (const [pid, set] of laneOfPeer)
				(out.laneOfPeer as Record<string, string[]>)[pid] = [...set].map((l) => l.name);
			for (const lane of lanes) {
				const pcs: Record<string, unknown> = {};
				for (const [pid, pc] of Object.entries(lane.room.getPeers()))
					pcs[pid] = {
						sig: pc.signalingState,
						conn: pc.connectionState,
						ice: pc.iceConnectionState,
						sctp: pc.sctp
							? {
									state: pc.sctp.state,
									dtls: pc.sctp.transport?.state,
									iceT: pc.sctp.transport?.iceTransport?.state
								}
							: null,
						mAppLocal: pc.localDescription?.sdp?.includes('m=application') ?? null,
						mAppRemote: pc.remoteDescription?.sdp?.includes('m=application') ?? null,
						send: pc.getSenders?.().map((s) => s.track?.kind ?? 'null'),
						recv: pc.getReceivers?.().map((r) => `${r.track.kind}:${r.track.readyState}`),
						trans: pc.getTransceivers?.().map((t) => `${t.direction}/${t.receiver.track?.kind}`)
					};
				(out.lanes as Record<string, unknown>)[lane.name] = {
					pcs,
					peerInfo: (lane.room as { __peerInfo?: () => unknown }).__peerInfo?.()
				};
			}
			return out;
		}
	};
	return handle;
}

/** room secret derivation: URL fragment carries entropy; never sent anywhere */
export function roomSecretFromCode(code: string, fragmentKey?: string): string {
	return `cic:${code}${fragmentKey ? `:${fragmentKey}` : ''}`;
}
