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
	addStream: (stream: MediaStream, targets?: string[]) => void;
	removeStream: (stream: MediaStream) => void;
	leave: () => Promise<void>;
	raw: Room;
	/** per-peer ICE state, merged across lanes */
	peerConnState: (peerId: string) => string;
	/** ICE-restart every peer connection (network flap / resume) */
	restartAll: () => void;
	/** resolves when the first lane is connected */
	ready: Promise<void>;
	/** resolved ICE server list (STUN + any TURN from env/broker) */
	iceServers: () => Promise<RTCIceServer[]>;
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

async function joinLane(lane: LaneName, secret: string, rtcConfig: RTCConfiguration): Promise<Room | null> {
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
				return openWsRoom(bus, secret, rtcConfig);
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

// ICE credentials are app-scoped (not room-scoped) — resolve once, share
// across rooms/breakouts, refresh on expiry via /api/ice re-fetch
let iceServersP: Promise<RTCConfiguration> | null = null;
export function iceServers(): Promise<RTCConfiguration> {
	return (iceServersP ??= fetchIceServers());
}
/** force re-resolve (credential expiry, broker change) */
export function refreshIceServers(): Promise<RTCConfiguration> {
	iceServersP = null;
	return iceServers();
}

/** fetch short-lived ICE servers from the edge broker; STUN fallback always present */
async function fetchIceServers(): Promise<RTCConfiguration> {
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
		const res = await fetch('/api/ice', { signal: AbortSignal.timeout(1800) });
		if (res.ok) {
			const body = (await res.json()) as { iceServers?: RTCIceServer[] };
			if (body.iceServers?.length) iceServers.push(...body.iceServers);
		}
	} catch {
		// no broker configured — STUN/env only
	}
	return { iceServers };
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

export function openRoom(roomSecret: string): RoomHandle {
	// shared listener sets — registered before/after lanes connect alike
	const laneOfPeer = new Map<string, Set<Lane>>();
	const lanes: Lane[] = [];
	const joinListeners = new Set<(peerId: string) => void>();
	const leaveListeners = new Set<(peerId: string) => void>();
	const streamListeners = new Set<(stream: MediaStream, peerId: string) => void>();
	const connStateListeners = new Set<(peerId: string, state: string) => void>();
	const opListeners = new Set<(env: OpEnvelope, peerId: string) => void>();
	const rtListeners = new Set<(msg: RealtimeMessage, peerId: string) => void>();
	// custom actions (notes sync etc.) — namespace → listeners; lane receivers
	// wire into these when the lane connects
	const actionListeners = new Map<string, Set<(data: unknown, peerId: string) => void>>();
	const pendingOps: OpEnvelope[] = [];
	const pendingRt: { msg: RealtimeMessage; to?: string }[] = [];
	const pendingStreams: { stream: MediaStream; targets?: string[] }[] = [];
	// streams currently requested of the mesh — re-applied to lanes that
	// connect late (retry path) so late-joining lanes aren't media-blind
	const activeStreams: { stream: MediaStream; targets?: string[] }[] = [];
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
			if (first) joinListeners.forEach((fn) => fn(peerId));
		});
		lane.onLeave((peerId) => {
			const set = laneOfPeer.get(peerId);
			if (!set) return;
			set.delete(lane);
			lane.iceStates.delete(peerId);
			if (set.size === 0) {
				laneOfPeer.delete(peerId);
				leaveListeners.forEach((fn) => fn(peerId));
			}
		});
		lane.onStream((stream, peerId) => streamListeners.forEach((fn) => fn(stream, peerId)));

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
		for (const { stream, targets } of activeStreams) {
			if (!targets) {
				lane.room.addStream(stream);
				continue;
			}
			const here = targets.filter((t) => laneOfPeer.get(t)?.has(lane));
			if (here.length) lane.room.addStream(stream, here);
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
	const joinWithRetry = async (name: LaneName, rtcConfig: RTCConfiguration) => {
		for (let i = 0; i < LANE_RETRIES; i++) {
			const room = await joinLane(name, roomSecret, rtcConfig).catch(() => null);
			if (room) {
				attach(name, room);
				if (!connected) {
					connected = true;
					flushPending();
				}
				return true;
			}
			await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** i, 15000)));
		}
		console.warn(`[net] lane ${name} gave up after ${LANE_RETRIES} attempts`);
		return false;
	};

	const ready = (async () => {
		const rtcConfig = await iceServers();
		await Promise.all(laneList().map((name) => joinWithRetry(name, rtcConfig)));
		if (!lanes.length) throw new Error('no signaling lanes available');
	})();

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
		addStream: (stream, targets) => {
			if (!connected) {
				pendingStreams.push({ stream, targets });
				return;
			}
			activeStreams.push({ stream, targets });
			for (const lane of lanes) {
				if (!targets) {
					lane.room.addStream(stream);
					continue;
				}
				const here = targets.filter((t) => laneOfPeer.get(t)?.has(lane));
				if (here.length) lane.room.addStream(stream, here);
			}
		},
		removeStream: (stream) => {
			const i = activeStreams.findIndex((s) => s.stream === stream);
			if (i >= 0) activeStreams.splice(i, 1);
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
		restartAll,
		ready,
		iceServers: async () => (await iceServers()).iceServers ?? []
	};
	return handle;
}

/** room secret derivation: URL fragment carries entropy; never sent anywhere */
export function roomSecretFromCode(code: string, fragmentKey?: string): string {
	return `cic:${code}${fragmentKey ? `:${fragmentKey}` : ''}`;
}
