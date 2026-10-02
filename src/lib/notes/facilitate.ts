/**
 * facilitate.ts — the facilitation suite lives inside the synced notes doc.
 * Polls are taskLists (votes = checkbox state — interactive, synced, E2EE),
 * agenda is an ordered list, stats/recaps append as generated markdown-shaped
 * sections. Everything lands in the room's shared Y.Doc — zero new sync
 * plumbing, and it all flows through the existing E2EE'd data channel.
 */
import * as Y from 'yjs';
import type { NotesDoc } from './notes';

function el(name: string, attrs: Record<string, string> = {}, text?: string): Y.XmlElement {
	const e = new Y.XmlElement(name);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
	if (text !== undefined) {
		const p = new Y.XmlElement('p');
		p.insert(0, [new Y.XmlText(text)]);
		e.push([p]);
	}
	return e;
}

function para(text: string): Y.XmlElement {
	const p = new Y.XmlElement('p');
	p.insert(0, [new Y.XmlText(text)]);
	return p;
}

/** Poll — a taskList; voters tick their choice (state syncs to everyone) */
export function addPoll(notes: NotesDoc, question: string, options: string[]) {
	const frag = notes.text;
	frag.push([el('h2', {}, question)]);
	const list = new Y.XmlElement('taskList');
	for (const opt of options) list.push([el('taskItem', { checked: 'false' }, opt)]);
	frag.push([list]);
}

/** Agenda — ordered list of items */
export function addAgenda(notes: NotesDoc, items: string[]) {
	const frag = notes.text;
	frag.push([el('h2', {}, 'Agenda')]);
	const list = new Y.XmlElement('orderedList');
	for (const item of items) list.push([el('listItem', {}, item)]);
	frag.push([list]);
}

/** Generated section — recaps, talk-time stats, Milo summaries */
export function addSection(notes: NotesDoc, title: string, lines: string[]) {
	const frag = notes.text;
	frag.push([el('h2', {}, title)]);
	for (const line of lines) frag.push([para(line)]);
}

/**
 * Talk-time equity report — appended by the authority at room end (or on
 * demand). Lines are "Name — M:SS (P%)" — the stat Zoom doesn't compute.
 */
export function addTalkTimeStats(notes: NotesDoc, talkMsByPeer: Record<string, number>, names: Record<string, string>) {
	const total = Object.values(talkMsByPeer).reduce((a, b) => a + b, 0);
	const lines = Object.entries(talkMsByPeer)
		.sort(([, a], [, b]) => b - a)
		.map(([id, ms]) => {
			const mm = Math.floor(ms / 60000);
			const ss = Math.floor((ms % 60000) / 1000);
			const pct = total ? Math.round((ms / total) * 100) : 0;
			return `${names[id] ?? id} — ${mm}:${String(ss).padStart(2, '0')} (${pct}%)`;
		});
	addSection(notes, 'Talk time', lines);
}
