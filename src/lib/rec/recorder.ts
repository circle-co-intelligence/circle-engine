import {
	Output,
	WebMOutputFormat,
	BufferTarget,
	CanvasSource,
	MediaStreamAudioTrackSource,
	QUALITY_MEDIUM
} from 'mediabunny';
import Dexie, { type EntityTable } from 'dexie';

/**
 * Client-side recorder — composes remote+local video onto a canvas, mixes audio
 * via WebAudio, muxes WebM through mediabunny into an OPFS/IndexedDB journal.
 * Segments roll every SEGMENT_MS so crash loss is bounded ~5s (journal chunks)
 * and ~30s (segment granularity).
 *
 * recorder-primary / recorder-standby are elected roles (roles/auction.ts);
 * heartbeat ops drive promotion when the primary disappears.
 */

const SEGMENT_MS = 30_000;
const JOURNAL_MS = 5_000;

interface JournalEntry {
	id?: number;
	roomCode: string;
	segment: number;
	at: number; // authority-clock timestamp
	bytes: ArrayBuffer;
}

const db = new Dexie('cic-recorder') as Dexie & { journal: EntityTable<JournalEntry, 'id'> };
db.version(1).stores({ journal: '++id, roomCode, segment, at' });

export class Recorder {
	private output: Output | null = null;
	private canvas = document.createElement('canvas');
	private ctx = this.canvas.getContext('2d')!;
	private audioCtx = new AudioContext();
	private mixDest = this.audioCtx.createMediaStreamDestination();
	private segment = 0;
	private journalTimer = 0;
	running = false;

	constructor(private roomCode: string) {
		this.canvas.width = 1280;
		this.canvas.height = 720;
	}

	addAudioStream(stream: MediaStream) {
		this.audioCtx.createMediaStreamSource(stream).connect(this.mixDest);
	}

	/** draw grid of participant videos — called per rAF while running */
	drawFrame(videos: HTMLVideoElement[]) {
		const { ctx, canvas } = this;
		ctx.fillStyle = '#181d23';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		const n = Math.max(1, videos.length);
		const cols = Math.ceil(Math.sqrt(n));
		const rows = Math.ceil(n / cols);
		const w = canvas.width / cols;
		const h = canvas.height / rows;
		videos.forEach((v, i) => {
			if (v.readyState >= 2) ctx.drawImage(v, (i % cols) * w, Math.floor(i / cols) * h, w, h);
		});
	}

	async start() {
		if (this.running) return;
		this.running = true;
		await this.openSegment();
		this.journalTimer = window.setInterval(() => void this.flushJournal(), JOURNAL_MS);
	}

	private async openSegment() {
		const target = new BufferTarget();
		this.output = new Output({
			format: new WebMOutputFormat(),
			target
		});
		const canvasSource = new CanvasSource(this.canvas, { codec: 'vp9', bitrate: 2_500_000 });
		this.output.addVideoTrack(canvasSource, { frameRate: 24 });
		const audioTrack = this.mixDest.stream.getAudioTracks()[0];
		if (audioTrack) {
			this.output.addAudioTrack(
				new MediaStreamAudioTrackSource(audioTrack, { codec: 'opus', quality: QUALITY_MEDIUM })
			);
		}
		await this.output.start();
	}

	/** persist the in-progress segment's bytes; bounds crash loss to JOURNAL_MS */
	private async flushJournal() {
		if (!this.output) return;
		// mediabunny BufferTarget accumulates muxed bytes; snapshot into journal
		const buf = (this.output.target as BufferTarget).buffer;
		if (buf && buf.byteLength > 0) {
			await db.journal.add({
				roomCode: this.roomCode,
				segment: this.segment,
				at: Date.now(),
				bytes: buf.slice(0)
			});
		}
	}

	async rotateSegment() {
		if (!this.running) return;
		await this.flushJournal();
		await this.output?.finalize();
		this.segment++;
		await this.openSegment();
	}

	/** explicit end only — room-end / end-recording op calls this */
	async stop(): Promise<Blob[]> {
		this.running = false;
		clearInterval(this.journalTimer);
		await this.flushJournal();
		await this.output?.finalize();
		this.output = null;
		return this.exportSegments();
	}

	async exportSegments(): Promise<Blob[]> {
		const entries = await db.journal.where('roomCode').equals(this.roomCode).sortBy('segment');
		const bySegment = new Map<number, Blob[]>();
		for (const e of entries) {
			const list = bySegment.get(e.segment) ?? [];
			list.push(new Blob([e.bytes], { type: 'video/webm' }));
			bySegment.set(e.segment, list);
		}
		return [...bySegment.values()].map((parts) => new Blob(parts, { type: 'video/webm' }));
	}

	async purge() {
		await db.journal.where('roomCode').equals(this.roomCode).delete();
	}
}
