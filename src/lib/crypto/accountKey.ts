/**
 * accountKey.ts — self-certifying billing identity.
 *
 * accountId = sha256(SPKI) hex — the account IS its public key. The private
 * key is a non-extractable WebCrypto P-256 CryptoKey in IndexedDB: XSS can
 * invoke signing while on-origin but can never read key bytes; URLs, logs
 * and localStorage hold only the public identifier. Every credential-bearing
 * request carries x-cic-pub/ts/nonce/sig headers; workers derive the account
 * from the key (or its registered delegate) and verify — a leaked accountId
 * alone spends nothing.
 *
 * Multi-device: extra device keys register as delegates on the account via
 * a signature from an existing key (see /pay/link-*).
 *
 * Lost last device = lost wallet — there is deliberately no recovery seed.
 */
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

const DB_NAME = 'cic-keys';
const STORE = 'keys';
const SIG_WINDOW_S = 300;

export interface AccountKeys {
	accountId: string; // sha256(spki) — also the primary keyHash
	pub: Uint8Array; // SPKI bytes
	priv: CryptoKey; // non-extractable
}

let cached: Promise<AccountKeys> | null = null;

function openDb(): Promise<IDBDatabase> {
	return new Promise((res, rej) => {
		const r = indexedDB.open(DB_NAME, 1);
		r.onupgradeneeded = () => r.result.createObjectStore(STORE);
		r.onsuccess = () => res(r.result);
		r.onerror = () => rej(r.error);
	});
}

async function idbGet(key: string): Promise<unknown> {
	const db = await openDb();
	return new Promise((res, rej) => {
		const r = db.transaction(STORE).objectStore(STORE).get(key);
		r.onsuccess = () => res(r.result);
		r.onerror = () => rej(r.error);
	});
}

async function idbPut(key: string, value: unknown): Promise<void> {
	const db = await openDb();
	return new Promise((res, rej) => {
		const r = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
		r.onsuccess = () => res();
		r.onerror = () => rej(r.error);
	});
}

export function keyHash(pub: Uint8Array): string {
	return bytesToHex(sha256(pub));
}

/** load-or-generate this device's account keypair; accountId derives from it */
export async function accountKeys(): Promise<AccountKeys> {
	return (cached ??= (async () => {
		const stored = (await idbGet('account')) as
			| { priv: CryptoKey; pub: ArrayBuffer }
			| undefined;
		if (stored?.priv && stored.pub) {
			const pub = new Uint8Array(stored.pub);
			return { accountId: keyHash(pub), pub, priv: stored.priv };
		}
		// non-extractable pair — WebCrypto always leaves publicKey exportable
		const pair = await crypto.subtle.generateKey(
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['sign']
		);
		const pub = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
		await idbPut('account', { priv: pair.privateKey, pub: pub.buffer });
		return { accountId: keyHash(pub), pub, priv: pair.privateKey };
	})());
}

/** the accountId this device signs for — null only if crypto is unavailable */
export async function accountId(): Promise<string> {
	return (await accountKeys()).accountId;
}

/**
 * Sign a request: returns the x-cic-* headers a worker verifies.
 * `path` is the canonical worker path (e.g. '/pay/convert', '/ai/usage',
 * 'sessions/new'); `body` must be the exact bytes sent. `forAccount` is the
 * accountId being claimed — it differs from this device's keyHash when the
 * key is a registered delegate (multi-device linking).
 */
export async function signRequest(
	method: string,
	path: string,
	body?: string,
	forAccount?: string
): Promise<Record<string, string>> {
	const keys = await accountKeys();
	const claimed = forAccount ?? keys.accountId;
	const ts = Math.floor(Date.now() / 1000);
	const nonce = crypto.randomUUID();
	const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body ?? '')));
	const payload = [
		claimed,
		method.toUpperCase(),
		path,
		bodyHash,
		String(ts),
		nonce,
		keys.accountId
	].join('\n');
	const sig = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		keys.priv,
		new TextEncoder().encode(payload)
	);
	return {
		'x-cic-pub': bytesToHex(keys.pub),
		'x-cic-ts': String(ts),
		'x-cic-nonce': nonce,
		'x-cic-sig': bytesToHex(new Uint8Array(sig))
	};
}

// ---------------------------------------------------------------- passkeys
//
// Opt-in hardware step-up: once a passkey is enrolled, high-risk billing ops
// (portal, link-approve, revoke, large converts) require a WebAuthn
// assertion on top of the device signature — origin-bound, phishing-proof.

export interface PasskeyCred {
	credId: string; // base64url credential id — the server-side lookup key
	pubSpki: string; // hex SPKI the worker verifies assertions against
	name: string;
}

export function passkeysSupported(): boolean {
	return typeof PublicKeyCredential !== 'undefined' && !!navigator.credentials;
}

function b64url(buf: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(buf)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

export async function passkeyEnroll(accountIdHex: string, name: string): Promise<PasskeyCred | null> {
	if (!passkeysSupported()) return null;
	const challenge = crypto.getRandomValues(new Uint8Array(32));
	const cred = (await navigator.credentials.create({
		publicKey: {
			challenge,
			rp: { name: 'Circle Engine' },
			user: {
				id: new TextEncoder().encode(accountIdHex).slice(0, 64) as BufferSource,
				name: `cic-${accountIdHex.slice(0, 12)}`,
				displayName: 'Circle billing'
			},
			pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256
			authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
			attestation: 'none'
		}
	})) as PublicKeyCredential | null;
	const res = cred?.response as AuthenticatorAttestationResponse | undefined;
	const spki = res?.getPublicKey?.();
	if (!cred || !spki) return null;
	return { credId: b64url(cred.rawId), pubSpki: bytesToHex(new Uint8Array(spki)), name };
}

export interface PasskeyAssertion {
	credId: string;
	authenticatorData: string; // base64url
	clientDataJSON: string; // base64url
	signature: string; // base64url
}

export async function passkeyAssert(
	credIds: string[],
	challengeB64: string
): Promise<PasskeyAssertion | null> {
	if (!passkeysSupported()) return null;
	const challenge = Uint8Array.from(atob(challengeB64.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
		c.charCodeAt(0)
	);
	const cred = (await navigator.credentials.get({
		publicKey: {
			challenge,
			allowCredentials: credIds.map((id) => ({
				type: 'public-key' as const,
				id: Uint8Array.from(atob(id.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
			})),
			userVerification: 'required'
		}
	})) as PublicKeyCredential | null;
	const res = cred?.response as AuthenticatorAssertionResponse | undefined;
	if (!cred || !res) return null;
	return {
		credId: b64url(cred.rawId),
		authenticatorData: b64url(res.authenticatorData),
		clientDataJSON: b64url(res.clientDataJSON),
		signature: b64url(res.signature)
	};
}

export { SIG_WINDOW_S };
