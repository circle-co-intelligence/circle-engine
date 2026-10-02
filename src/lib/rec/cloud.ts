/**
 * cloud.ts — paid-tier encrypted cloud recording. Segment blobs are sealed
 * client-side (XChaCha20-Poly1305, key = HKDF(roomSecret)) before PUT, so R2
 * only ever holds ciphertext — zero plaintext retention on our edge.
 *
 * Upload path:  PUT /api/rec/{room}/{recId}/{segment}  → R2 object
 * Fetch path:   GET /api/rec/{room}/{recId}/{segment}  → ciphertext
 * Playback:     fetch → decrypt → blob URL → native <video>
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { paidEntitled } from '../tier';

const enc = new TextEncoder();

function recKey(roomSecret: string): Uint8Array {
	return hkdf(sha256, utf8ToBytes(roomSecret), undefined, enc.encode('cic-rec-v1'), 32);
}

/** seal a recording blob; returns ciphertext with a 24B nonce prefix */
export function sealSegment(roomSecret: string, plain: Uint8Array): Uint8Array {
	const nonce = randomBytes(24);
	const sealed = xchacha20poly1305(recKey(roomSecret), nonce).encrypt(plain);
	const out = new Uint8Array(24 + sealed.length);
	out.set(nonce);
	out.set(sealed, 24);
	return out;
}

export function openSegment(roomSecret: string, sealed: Uint8Array): Uint8Array {
	return xchacha20poly1305(recKey(roomSecret), sealed.slice(0, 24)).decrypt(sealed.slice(24));
}

/** upload encrypted segments to R2 — paid-gated, no-op without entitlement */
export async function uploadRecording(
	roomSecret: string,
	roomCode: string,
	segments: Blob[]
): Promise<string | null> {
	if (!(await paidEntitled(roomCode))) return null;
	const recId = crypto.randomUUID();
	for (let i = 0; i < segments.length; i++) {
		const sealed = sealSegment(roomSecret, new Uint8Array(await segments[i].arrayBuffer()));
		const res = await fetch(`/api/rec/${roomCode}/${recId}/${i}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/octet-stream' },
			body: sealed.buffer as ArrayBuffer
		});
		if (!res.ok) return null;
	}
	return recId;
}

/** fetch + decrypt a recording; returns a playable object URL */
export async function fetchRecording(
	roomSecret: string,
	roomCode: string,
	recId: string,
	segment = 0
): Promise<string | null> {
	const res = await fetch(`/api/rec/${roomCode}/${recId}/${segment}`);
	if (!res.ok) return null;
	const plain = openSegment(roomSecret, new Uint8Array(await res.arrayBuffer()));
	return URL.createObjectURL(new Blob([plain as BlobPart], { type: 'video/webm' }));
}
