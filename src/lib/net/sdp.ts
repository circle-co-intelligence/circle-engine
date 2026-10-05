/**
 * SDP hygiene helpers for cross-engine interop.
 */

const EXMAP_RE = /^a=extmap:(\d+)((?:\/\w+)?) (\S+.*)$/;

/**
 * Canonical RTP header-extension ids — every description applied anywhere in
 * the app is rewritten to this table.
 *
 * Why: Chromium rejects a remote description with "RTP extension ID
 * reassignment not supported" whenever an extmap id maps a different URI than
 * its active bundle state remembers. Firefox numbers extmaps per m-line and
 * renumbers them across offers, so nearly every Cr↔Fx negotiation tripped
 * this — bundled offers assign the same id to different URIs across m-lines,
 * and re-offers remap ids Chrome already bound. Worse, ids on recvonly
 * sections don't reach Chrome's transport table, so any stateful "remember
 * what the pc saw" scheme still desynchronizes from what Chrome negotiated.
 *
 * A static table removes the state entirely: the applied description AND the
 * negotiated result both come out of this one map, so a pc can never see a
 * conflicting binding. Rewriting is spec-safe — wire ids come from the
 * negotiated answer, which carries these same ids.
 *
 * Every URI needs a GLOBALLY stable id — a per-desc "keep the original id
 * when free" heuristic still reassigns an id whenever the desc's URI set
 * changes between offers, which is exactly what Chrome rejects. The
 * rid/simulcast family is essential (a simulcast offer whose rid extmap was
 * dropped or renumbered is rejected outright), so it holds canonical slots
 * alongside the common set; rarely-negotiated extensions move to the
 * two-byte range (15+, legal because both engines advertise
 * a=extmap-allow-mixed). Genuinely unknown URIs get a deterministic FNV-1a
 * hash id so they never collide between descriptions either.
 */
const EXMAP_IDS: Record<string, number> = {
	'urn:ietf:params:rtp-hdrext:ssrc-audio-level': 1,
	'urn:ietf:params:rtp-hdrext:csrc-audio-level': 2,
	'urn:ietf:params:rtp-hdrext:sdes:mid': 3,
	'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time': 4,
	'urn:ietf:params:rtp-hdrext:toffset': 5,
	'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay': 6,
	'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01': 7,
	'urn:3gpp:video-orientation': 8,
	'http://www.webrtc.org/experiments/rtp-hdrext/video-content-type': 9,
	'http://www.webrtc.org/experiments/rtp-hdrext/video-timing': 10,
	'urn:ietf:params:rtp-hdrext:rid': 11,
	'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id': 12,
	'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id': 13,
	'urn:ietf:params:rtp-hdrext:framemarking': 14,
	'http://www.webrtc.org/experiments/rtp-hdrext/color-space': 15,
	'urn:ietf:params:rtp-hdrext:encrypt': 16,
	'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time': 17
};

/** deterministic id in the two-byte range for URIs outside the table */
function hashExtmapId(uri: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < uri.length; i++) {
		h ^= uri.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return 32 + ((h >>> 0) % 96); // 32-127
}

/** rewrite all extmap lines to deterministic ids — canonical table + stable hash */
export function normalizeExtmaps(sdp: string): string {
	const taken = new Set<number>();
	const assigned = new Map<string, number>();
	return sdp
		.split('\r\n')
		.map((line) => {
			const m = EXMAP_RE.exec(line);
			if (!m) return line;
			let id = assigned.get(m[3]);
			if (id === undefined) {
				id = EXMAP_IDS[m[3]] ?? hashExtmapId(m[3]);
				while (taken.has(id)) id++; // deterministic base; bump on the rare hash clash
				assigned.set(m[3], id);
				taken.add(id);
			}
			return `a=extmap:${id}${m[2]} ${m[3]}`;
		})
		.join('\r\n');
}
