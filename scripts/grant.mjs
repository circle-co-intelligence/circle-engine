#!/usr/bin/env node
/**
 * grant.mjs — mint a signed pool top-up grant.
 *
 * The payment rail is decoupled: whatever settles the money (checkout
 * webhook, streaming-payment settlement, invoice batch, admin manual grant)
 * runs this after settlement and hands the client the grant string.
 * The client POSTs it to /ai/topup; the worker verifies Ed25519 against
 * GRANT_PUBKEY and credits the room's seconds pool. Sequential top-ups
 * are the "stream" — the pool is never locked.
 *
 * Usage:
 *   GRANT_SECRET=<hex-ed25519-secret> node scripts/grant.mjs <room> <seconds>
 *
 * Prints the base64url grant. Pair the secret's public key into the
 * ai-gateway secret store:
 *   wrangler secret put GRANT_PUBKEY   (in workers/ai-gateway)
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';

const [room, secsRaw] = process.argv.slice(2);
const secret = process.env.GRANT_SECRET;
if (!room || !secsRaw || !secret) {
	console.error('usage: GRANT_SECRET=<hex> node scripts/grant.mjs <room> <seconds>');
	process.exit(1);
}
const seconds = Math.round(Number(secsRaw));
if (!Number.isFinite(seconds) || seconds <= 0) {
	console.error('seconds must be a positive integer');
	process.exit(1);
}
const nonce = bytesToHex(randomBytes(16));
const sig = bytesToHex(
	ed25519.sign(new TextEncoder().encode(`${room}.${seconds}.${nonce}`), hexToBytes(secret))
);
const grant = Buffer.from(JSON.stringify({ seconds, nonce, sig })).toString('base64url');
console.log(grant);
console.error(`pubkey: ${bytesToHex(ed25519.getPublicKey(hexToBytes(secret)))}`);
