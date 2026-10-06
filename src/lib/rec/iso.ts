/**
 * iso.ts — Riverside-style ISO recording, with the privacy upgrade they
 * can't offer. Each participant records its OWN raw feed (never the
 * remote-decoded stream — network loss can't degrade source quality),
 * segments rotate, every segment is sealed XChaCha20-Poly1305 client-side
 * and uploaded progressively during the session. A crash or offline gap
 * leaves ciphertext in the journal; resumeUploads() drains it next join.
 *
 * The composite Recorder still runs for the convenience single-file mix —
 * ISO tracks are the production-master path: per-participant, per-segment,
 * feedable into clip.ts / an external compositor.
 */
import {
	Output,
	WebMOutputFormat,
	BufferTarget,
	MediaStreamVideoTrackSource,
	MediaStreamAudioTrackSource,
	QUALITY_HIGH,
	QUALITY_MEDIUM
} from 'mediabunny';
import Dexie, { type EntityTable } from 'dexie';
import { sealSegment, recTicket } from './cloud';

const SEGMENT_MS = 30_000;

interface IsoUpload {
	id?: number;
	roomCode: string;
	rec: string; // recording id — isolates one participant's ISO stream
	seg: number;
	at: number;
	bytes: ArrayBuffer; // ciphertext — plaintext never touches the journal
	done: boolean;
}

const db = new Dexie('cic-iso') as Dexie & { uploads: EntityTable<IsoUpload, 'id'> };
db.version(1).stores({ uploads: '++id, roomCode, rec, seg, at, done' });

export interface IsoSegmentInfo {
	rec: string;
	seg: number;
	durationMs: number;
	bytes: number;
	ts: number;
}

export class IsoRecorder {
	private output: Output | null = null;
	private sources: (MediaStreamVideoTrackSource | MediaStreamAudioTrackSource)[] = [];
	private seg = 0;
	private segStarted = 0;
	private rotateTimer = 0;
	private uploading = 0;
	running = false;
	/** fired after each segment is sealed + upload queued — session broadcasts rec-manifest */
	onSegment: ((info: IsoSegmentInfo) => void) | null = null;
	readonly rec: string;

	constructor(
		private roomCode: string,
		private roomSecret: string,
		private selfId: string,
		private paid: () => Promise<boolean>
	) {
		this.rec = `iso-${selfId.slice(0, 12)}-${Date.now().toString(36)}`;
	}

	/** begin ISO-recording our own raw feed — source quality, network-immune */
	async start(stream: MediaStream) {
		if (this.running || !stream.getTracks().length) return;
		this.running = true;
		this.stream = stream;
		await this.openSegment();
		this.rotateTimer = window.setInterval(() => void this.rotate(), SEGMENT_MS);
		// crash-resume: drain anything a previous session left behind
		void this.resumeUploads();
	}

	private stream!: MediaStream;

	private async openSegment() {
		const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
		const hi = await this.paid();
		for (const track of this.stream.getTracks()) {
			if (track.kind === 'video' && track.readyState === 'live') {
				// paid tiers encode at source quality (up to 4K); free ISO still
				// beats composite — it's the unmixed feed, just a leaner bitrate
				const src = new MediaStreamVideoTrackSource(track as MediaStreamVideoTrack, {
					codec: 'vp9',
					bitrate: hi ? 8_000_000 : 4_000_000
				});
				this.sources.push(src);
				output.addVideoTrack(src);
			} else if (track.kind === 'audio' && track.readyState === 'live') {
				const src = new MediaStreamAudioTrackSource(track as MediaStreamAudioTrack, {
					codec: 'opus',
					quality: hi ? QUALITY_HIGH : QUALITY_MEDIUM
				});
				this.sources.push(src);
				output.addAudioTrack(src);
			}
		}
		this.output = output;
		this.segStarted = Date.now();
		await output.start();
	}

	private async finalizeSegment(): Promise<void> {
		const output = this.output;
		if (!output) return;
		this.output = null;
		for (const s of this.sources.splice(0)) s.close();
		await output.finalize();
		const plain = (output.target as BufferTarget).buffer;
		if (!plain || !plain.byteLength) return;
		const info: IsoSegmentInfo = {
			rec: this.rec,
			seg: this.seg,
			durationMs: Date.now() - this.segStarted,
			bytes: plain.byteLength,
			ts: this.segStarted
		};
		const sealed = sealSegment(this.roomSecret, new Uint8Array(plain));
		// journal ciphertext before attempting the network — a crash here
		// loses nothing; resumeUploads drains it on next join
		const jid = (await db.uploads.add({
			roomCode: this.roomCode,
			rec: this.rec,
			seg: this.seg,
			at: Date.now(),
			bytes: sealed.buffer as ArrayBuffer,
			done: false
		})) as number;
		this.seg++;
		this.onSegment?.(info);
		this.uploading++;
		void this.push(sealed, info.seg, jid).finally(() => this.uploading--);
	}

	private async rotate() {
		await this.finalizeSegment();
		if (this.running) await this.openSegment();
	}

	/** PUT one sealed segment — retry backoff; journal row persists failures */
	private async push(sealed: Uint8Array, seg: number, jid: number, rec = this.rec): Promise<boolean> {
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				const res = await fetch(`/api/rec/${this.roomCode}/${rec}/${seg}`, {
					method: 'PUT',
					headers: {
						'content-type': 'application/octet-stream',
						// membership capability — the edge charges the room's pool
						// per MiB before writing; 402 = out of credits, stop retrying
						'x-cic-room-ticket': recTicket(this.roomSecret, this.roomCode)
					},
					body: sealed.buffer as ArrayBuffer
				});
				if (res.status === 402) return false; // exhausted — journal keeps the bytes
				if (res.ok) {
					await db.uploads.update(jid, { done: true });
					return true;
				}
			} catch { /* offline — journal keeps it */ }
			await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
		}
		return false;
	}

	/** drain journaled-but-unuploaded segments (crash/offline resume) */
	async resumeUploads(): Promise<number> {
		const pending = await db.uploads.where('roomCode').equals(this.roomCode).filter((u) => !u.done).toArray();
		let done = 0;
		for (const u of pending) {
			const ok = await this.push(new Uint8Array(u.bytes), u.seg, u.id!, u.rec);
			if (ok) done++;
		}
		return done;
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		clearInterval(this.rotateTimer);
		await this.finalizeSegment();
		// wait for in-flight uploads so a quick leave doesn't orphan them
		for (let i = 0; i < 50 && this.uploading; i++) await new Promise((r) => setTimeout(r, 200));
	}

	/** consent withdrawn mid-record — stop now and drop this rec's journaled
	 *  (still-local) segments. Already-uploaded ciphertext is removed via
	 *  DELETE /api/rec; only forward content is guaranteed excluded. */
	async discard(): Promise<void> {
		await this.stop();
		await db.uploads
			.where('roomCode').equals(this.roomCode)
			.filter((u) => u.rec === this.rec)
			.delete();
		// best-effort server-side removal of what already uploaded
		try {
			await fetch(`/api/rec/${this.roomCode}/${this.rec}`, { method: 'DELETE' });
		} catch { /* offline — ciphertext-only objects remain until purge */ }
	}

	/** erase this room's journaled ISO bytes (retention / delete control) */
	static async purge(roomCode: string): Promise<void> {
		await db.uploads.where('roomCode').equals(roomCode).delete();
	}
}
