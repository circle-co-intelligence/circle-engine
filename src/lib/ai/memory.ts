/**
 * memory.ts — Milo's persistent, host-anchored memory.
 *
 * "Stay with the host": items live in a per-room Dexie journal on the
 * room authority's device — never on a server, never broadcast to peers.
 * Every row is sealed client-side (XChaCha20-Poly1305, HKDF(roomSecret) —
 * same scheme as cloud recordings), so the journal is ciphertext at rest:
 * possession of the device alone reveals nothing without the room secret.
 *
 * Cross-conversation recall: rows are keyed by room code, so every
 * session of the same room link shares Milo's memory — a circle that
 * meets weekly accumulates context across all of its conversations.
 *
 * Consent bounds carry through: memory text is only ever distilled from
 * lines that already passed the ear-set consent gate, and items carry an
 * optional `by` attribution so self-erasure purges a peer's contributions.
 */
import Dexie, { type EntityTable } from 'dexie';
import { sealSegment, openSegment } from '../rec/cloud';

export interface MemItem {
	text: string;
	by?: string; // peerId attribution — drives self-erasure purges
}

interface MemRow {
	id: string;
	room: string;
	ts: number;
	sealed: Uint8Array;
}

const PER_ROOM_CAP = 300;
const RECALL_LIMIT = 60;

const db = new Dexie('cic-milo') as Dexie & { mem: EntityTable<MemRow, 'id'> };
db.version(1).stores({ mem: 'id, room, ts' });

function seal(room: string, secret: string, item: MemItem): MemRow {
	return {
		id: crypto.randomUUID(),
		room,
		ts: Date.now(),
		sealed: sealSegment(secret, new TextEncoder().encode(JSON.stringify(item)))
	};
}

function open(row: MemRow, secret: string): MemItem | null {
	try {
		return JSON.parse(new TextDecoder().decode(openSegment(secret, row.sealed))) as MemItem;
	} catch {
		return null; // wrong-room secret or corruption — skip the row
	}
}

/** persist items for a room, newest-capped; returns rows written */
export async function addMemories(room: string, secret: string, items: MemItem[]): Promise<number> {
	const clean = items
		.map((i) => ({ text: i.text.trim().slice(0, 300), by: i.by }))
		.filter((i) => i.text.length > 0);
	if (!clean.length) return 0;
	await db.mem.bulkPut(clean.map((i) => seal(room, secret, i)));
	// prune oldest beyond the cap — the journal stays a bounded ring
	const over = await db.mem.where('room').equals(room).sortBy('ts');
	if (over.length > PER_ROOM_CAP)
		await db.mem.bulkDelete(over.slice(0, over.length - PER_ROOM_CAP).map((r) => r.id));
	return clean.length;
}

/** most recent items for the room, oldest→newest (prompt order) */
export async function loadMemories(room: string, secret: string, limit = RECALL_LIMIT): Promise<MemItem[]> {
	const rows = await db.mem.where('room').equals(room).sortBy('ts');
	const out: MemItem[] = [];
	for (const r of rows.slice(-limit)) {
		const item = open(r, secret);
		if (item) out.push(item);
	}
	return out;
}

/** self-erasure: drop every item attributed to the peer, plus items whose
 *  text mentions their display name (best-effort for unattributed rows) */
export async function forgetPeer(room: string, secret: string, peerId: string, name?: string): Promise<number> {
	const rows = await db.mem.where('room').equals(room).sortBy('ts');
	const drop: string[] = [];
	for (const r of rows) {
		const item = open(r, secret);
		if (!item) continue;
		if (item.by === peerId || (name && item.text.toLowerCase().includes(name.toLowerCase())))
			drop.push(r.id);
	}
	await db.mem.bulkDelete(drop);
	return drop.length;
}

/** room wipe — 'milo forget everything' (manager-gated at the call site) */
export async function wipeRoom(room: string): Promise<number> {
	return db.mem.where('room').equals(room).delete();
}

/** memory block prepended to a brain prompt — capped for the local
 *  model's small context window */
export function memoryBlock(items: MemItem[], maxChars = 1200): string {
	const lines: string[] = [];
	let chars = 0;
	for (const it of items.slice().reverse()) { // newest first until budget fills
		const line = `- ${it.text}`;
		if (chars + line.length > maxChars) break;
		lines.unshift(line);
		chars += line.length;
	}
	return lines.length
		? `Things you remember from earlier circles in this room:\n${lines.join('\n')}\n\n`
		: '';
}

/** distill prompt — asks the active brain to extract durable facts from
 *  the rolling window. One fact per line keeps parsing reliable even on
 *  the small local model; chatty prefixes are stripped. */
export const DISTILL_PROMPT =
	'From this circle transcript, extract up to 4 things worth remembering ' +
	'for future conversations — preferences, decisions, ongoing topics, ' +
	'who is working on what. One short fact per line, no preamble, no ' +
	'bullets beyond a leading dash. If nothing is durable, answer NONE.';

/** parse a distill reply into items — strips numbering/dashes/preamble */
export function parseDistilled(reply: string): string[] {
	return reply
		.split('\n')
		.map((l) => l.replace(/^\s*[-•*\d.)\]]+\s*/, '').trim())
		.filter(
			(l) =>
				l.length >= 8 &&
				l.length <= 300 &&
				!/^none\b/i.test(l) &&
				!/^(here|the following|things?|facts?|summary|sure)\b/i.test(l)
		);
}
