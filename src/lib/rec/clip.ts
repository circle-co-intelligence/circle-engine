/**
 * clip.ts — transcript→clip extraction over ISO recordings. A transcript
 * span (diarized + timestamped by the sensory lane) maps to a time range;
 * mediabunny's Conversion trims the sealed-then-opened segment into a
 * standalone clip blob — copy-passthrough where keyframes allow, transcode
 * only when the range demands it.
 *
 * markers(): audio-event detections (laughter/applause from the sensory
 * lane) become suggested clip windows — Riverside has nothing equivalent.
 */
import {
	Input,
	Output,
	Conversion,
	WebMOutputFormat,
	BufferTarget,
	BlobSource,
	ALL_FORMATS
} from 'mediabunny';
import { openSegment } from './cloud';
import { fetchRecording } from './cloud';

/** trim a recording blob to [startS, endS) seconds → standalone WebM */
export async function clipBlob(blob: Blob, startS: number, endS: number): Promise<Blob> {
	const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
	const target = new BufferTarget();
	const output = new Output({ format: new WebMOutputFormat(), target });
	const conv = await Conversion.init({
		input,
		output,
		trim: { start: startS, end: endS }
	});
	if (!conv.isValid) throw new Error('clip: no usable tracks in range');
	await conv.execute();
	const buf = target.buffer;
	if (!buf?.byteLength) throw new Error('clip: empty output');
	return new Blob([buf], { type: 'video/webm' });
}

/** fetch + open a sealed ISO segment, clip a range, return blob URL */
export async function clipRemoteSegment(
	roomSecret: string,
	roomCode: string,
	rec: string,
	seg: number,
	startS: number,
	endS: number
): Promise<string | null> {
	const res = await fetch(`/api/rec/${roomCode}/${rec}/${seg}`);
	if (!res.ok) return null;
	const plain = openSegment(roomSecret, new Uint8Array(await res.arrayBuffer()));
	const clip = await clipBlob(new Blob([plain as BlobPart], { type: 'video/webm' }), startS, endS);
	return URL.createObjectURL(clip);
}

/** key-moment windows from sensory audio events — clip suggestions */
export function markers(events: { kind: string; at: number }[], padMs = 2500): { startS: number; endS: number }[] {
	const interesting = new Set(['laughter', 'applause', 'music']);
	return events
		.filter((e) => interesting.has(e.kind))
		.map((e) => ({ startS: Math.max(0, (e.at - padMs) / 1000), endS: (e.at + padMs) / 1000 }));
}

/** clip the composite (non-ISO) recording too — same path, different recId */
export { fetchRecording };
