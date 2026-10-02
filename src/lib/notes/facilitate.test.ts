import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { addPoll, addAgenda, addSection, addTalkTimeStats } from './facilitate';
import type { NotesDoc } from './notes';

/** minimal NotesDoc stand-in — facilitate.ts only touches .text */
function fakeNotes(): NotesDoc {
	return { text: new Y.Doc().getXmlFragment('notes') } as unknown as NotesDoc;
}

describe('facilitation blocks', () => {
	it('poll inserts a taskList with one taskItem per option', () => {
		const n = fakeNotes();
		addPoll(n, 'Go with option?', ['A', 'B', 'C']);
		const frag = n.text;
		expect(frag.length).toBe(2); // h2 + taskList
		const list = frag.get(frag.length - 1) as Y.XmlElement;
		expect(list.nodeName).toBe('taskList');
		expect(list.length).toBe(3);
		const item = list.get(0) as Y.XmlElement;
		expect(item.nodeName).toBe('taskItem');
		expect(item.getAttribute('checked')).toBe('false');
	});

	it('agenda inserts an orderedList', () => {
		const n = fakeNotes();
		addAgenda(n, ['Check-in', 'Topic', 'Check-out']);
		const list = n.text.get(1) as Y.XmlElement;
		expect(list.nodeName).toBe('orderedList');
		expect(list.length).toBe(3);
	});

	it('sections append heading + paragraphs', () => {
		const n = fakeNotes();
		addSection(n, 'Recap', ['line one', 'line two']);
		expect(n.text.length).toBe(3);
	});

	it('talk-time stats sort descending and compute percentages', () => {
		const n = fakeNotes();
		addTalkTimeStats(n, { a: 60_000, b: 120_000 }, { a: 'Ann', b: 'Bob' });
		const lines: string[] = [];
		for (let i = 1; i < n.text.length; i++) {
			const p = n.text.get(i) as Y.XmlElement;
			lines.push((p.get(0) as Y.XmlText).toString());
		}
		expect(lines[0]).toMatch(/^Bob — 2:00 \(67%\)$/);
		expect(lines[1]).toMatch(/^Ann — 1:00 \(33%\)$/);
	});
});
