/**
 * cic-signaling — Durable Object room-bus for optional cloud signaling.
 *
 * One DO per room-id (always a hash — the room secret never leaves the URL
 * fragment, so clients send sha256(secret) as the room key). Members connect
 * over WebSocket, are addressed by a random member id, and relay opaque
 * frames {to?: memberId, data: any}. The DO sees only ciphertext-sized
 * signaling blobs; media and room secrets never touch it.
 *
 * Routes (on the worker):
 *   GET  /room/:roomId/ws   (Upgrade: websocket) → join the bus
 *   GET  /room/:roomId/info → { members: n }
 *
 * Hibernation API keeps idle rooms free.
 */

export interface Env {
	ROOMS: DurableObjectNamespace;
}

const encoder = new TextEncoder();

async function roomKey(raw: string): Promise<string> {
	// never trust caller-supplied ids as DO names directly — normalize to a
	// fixed-length hash so namespace keys are uniform and unguessable-ish
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`cic:${raw}`));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		const m = url.pathname.match(/^\/room\/([^/]+)\/(ws|info)$/);
		if (!m) return new Response('not found', { status: 404 });
		const [, roomId, kind] = m;
		const stub = env.ROOMS.get(env.ROOMS.idFromName(await roomKey(roomId)));
		return stub.fetch(new Request(`https://do/${kind}`, req));
	}
};

interface MemberState {
	id: string;
	joinedAt: number;
}

export class RoomBus implements DurableObject {
	private seq = 0;

	constructor(private readonly ctx: DurableObjectState) {
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('ping', 'pong')
		);
	}

	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === '/info') {
			return Response.json({ members: this.ctx.getWebSockets().length });
		}
		if (url.pathname !== '/ws' || req.headers.get('upgrade') !== 'websocket')
			return new Response('expected websocket', { status: 426 });

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		const id = crypto.randomUUID().slice(0, 8);
		this.ctx.acceptWebSocket(server, [id]);
		server.serializeAttachment({ id, joinedAt: Date.now() } satisfies MemberState);
		server.send(JSON.stringify({ t: 'welcome', id, members: this.members() }));
		this.broadcast({ t: 'join', id }, server);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		const from = ws.deserializeAttachment() as MemberState;
		let frame: { to?: string; data?: unknown };
		try {
			frame = JSON.parse(String(raw));
		} catch {
			return;
		}
		const relay = { t: 'msg', from: from.id, data: frame.data };
		if (frame.to) {
			const target = this.ctx.getWebSockets(frame.to);
			target.forEach((s) => s.send(JSON.stringify(relay)));
			return;
		}
		this.broadcast(relay, ws);
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		const m = ws.deserializeAttachment() as MemberState | null;
		if (m) this.broadcast({ t: 'leave', id: m.id });
	}

	private members(): string[] {
		return this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as MemberState).id);
	}

	private broadcast(msg: unknown, except?: WebSocket): void {
		const payload = JSON.stringify(msg);
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === except) continue;
			try {
				ws.send(payload);
			} catch {
				/* socket dying — hibernation will reap it */
			}
		}
	}
}
