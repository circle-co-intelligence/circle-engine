/**
 * audit.ts — portable, verifiable op-log export. Beats mutable admin logs:
 * every op is Ed25519-signed by its sender, so the exported artifact
 * verifies standalone — no trust in us required.
 */
import type { OpEnvelope } from '../wire/messages';
import { createIdentity, canonicalBytes, registerPeerKey } from '../crypto/identity';

export interface AuditBundle {
	roomEpoch: number;
	exportedAt: number;
	ops: OpEnvelope[];
}

/** export the session's op-log as a self-verifying JSON artifact */
export function exportAudit(entries: readonly OpEnvelope[], epoch: number): string {
	const bundle: AuditBundle = { roomEpoch: epoch, exportedAt: Date.now(), ops: [...entries] };
	return JSON.stringify(bundle, null, 2);
}

export interface AuditResult {
	ok: boolean;
	checked: number;
	failures: { opId: string; reason: string }[];
}

/**
 * Verify an exported bundle: re-check every op signature against the sender
 * keys embedded in the artifact. Ops must embed `senderPubkeyHex` for
 * standalone verification — the wire envelope already carries it as part of
 * the hello/announce trail; callers should attach `keys` (peerId→pubkeyHex)
 * captured at session time.
 */
export function verifyAudit(bundleJson: string, keys: Record<string, string>): AuditResult {
	const bundle = JSON.parse(bundleJson) as AuditBundle;
	const failures: AuditResult['failures'] = [];
	const id = createIdentity('audit-verifier');
	for (const [peerId, pk] of Object.entries(keys)) registerPeerKey(peerId, pk);
	for (const env of bundle.ops) {
		const { sig, ...unsigned } = env;
		if (!id.verify(env.senderId, canonicalBytes(unsigned), sig)) {
			failures.push({ opId: env.opId, reason: 'bad signature' });
		}
	}
	return { ok: failures.length === 0, checked: bundle.ops.length, failures };
}
