/**
 * Post-build patch for static-host deploys (GitHub Pages).
 *
 * The vendored production bundle gates boot on hostname: off-localhost it
 * requires location.hostname to equal the prod engine host or its workers.dev
 * preview domain ("Engine and dashboard environments do not match"). On a
 * static host there is no engine host — the local bridge is the engine — so
 * the gate is neutralized *in the build artifact only*. Source and dev server
 * stay byte-pristine (dev never hits the check: it early-returns on localhost).
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MARKER = 'Engine and dashboard environments do not match';
// the gate tails `...;throw new Error(MARKER);return e` inside the env
// resolver i() — the same function the app injects as its API/dashboard base.
// Neutralizing the throw alone would return the prod origin, so fetches and
// images would still cross to co-intelligence.online (and the local bridge
// only shims same-origin paths). Returning our own origin+base makes every
// derived URL same-origin: bridge fetch/WS shims terminate them as designed.
const BASE = process.env.CIC_BASE ?? '';
const THROW_TAIL = `throw new Error("${MARKER}");return e`;
const REPLACEMENT = `;return location.origin+"${BASE}"`;

// Root-absolute static asset refs inside the vendored bundle resolve at the
// origin root on prod (engine serves at domain root). Under /<repo>/ they need
// the base prefix. Route/shim paths (/api, /ws, /room, /join, ...) are NOT in
// this list — the vendored router prepends base itself and the bridge shims
// match base-less pathnames intentionally.
const STATIC_PREFIXES = [
	'/assets/', '/fonts/', '/brand/', '/media/', '/site/', '/models/', '/wllama/',
	'/cic/', '/policy/', '/libarchive/'
];
const STATIC_FILES = [
	'/ai-flow.lottie', '/bluefire.lottie', '/campfire.lottie', '/sloth-meditate.lottie',
	'/wave.lottie', '/bg-cave-desktop.webp', '/bg-cave-mobile.webp', '/fire2.webp',
	'/fire-bowl.png',
	'/caption-capture-worklet.js', '/dg-capture-worklet.js', '/dotlottie-player.wasm',
	'/manifest.webmanifest', '/favicon.png', '/og.png', '/coi-serviceworker.js'
];
const ABS_RE = new RegExp(
	`(['"\`])((?:${[...STATIC_PREFIXES, ...STATIC_FILES.map((f) => f.replaceAll('.', '\\.'))].join('|')})[^'"\`]*)`,
	'g'
);
// vendored cic CSS escapes ../../../fonts/… written for prod's /assets/ depth —
// our bundle sits one level deeper (/cic/assets/), so collapse one hop.
// Scoped to cic only: site/_next css legitimately uses ../media/ sibling refs.
const CIC_CSS_ESCAPE_RE = /url\((['"]?)\.\.\/\.\.\/\.\.\//g;

// literal route hrefs in static HTML bypass the vendored router (which would
// prepend base itself for JS nav) — hard navigations need the prefix
const HTML_ROUTE_RE = /(href|src)="\/(join|demo|billing|login|account)"/g;
// site css kept prod's root-absolute /early-access/ refs — those files live
// under /site/early-access/ in the vendored site tree
const SITE_EARLY_RE = /url\((['"]?)\/early-access\//g;
// orphaned vendored pages still carry private-beta copy — the SPA never
// routes to them, but they're reachable by URL. site/login.html gets honest
// copy; index14cf.html is a stale landing variant → bounce to the real one.
const SITE_LOGIN_BETA = /<a class="btn btn-quiet btn-create"[^>]*>Request early access<\/a><p class="auth-create-note">[^<]*<\/p>/;
const SITE_LOGIN_FIX = `<a class="btn btn-quiet btn-create" href="/join">Open a circle — free</a><p class="auth-create-note">No account needed for everyday circles.</p>`;
const SITE_VARIANT_REDIRECT = (base) =>
	`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${base || ''}/"><title>Co-Intelligence Circle</title></head><body><a href="${base || ''}/">Co-Intelligence Circle</a></body></html>`;

// vendored device-check bug: denying the camera/mic permission prompt still
// opens the preview dialog — the click handler's catch tail re-opens it
// (`v(d,!0)`) after the failed capture. Flip the failure path so the dialog
// stays closed (the success path's v(d,!0) lives inside try, untouched).
const CAM_DENY_MARKER = 'Check camera & microphone';
const CAM_DENY_TAIL = ',v(H,Ba(),!0),v(d,!0)}';
const CAM_DENY_FIX = ',v(H,Ba(),!0),v(d,!1)}';

function patchJsCss(src, file = '') {
	if (file.endsWith('/site/index14cf.html')) return SITE_VARIANT_REDIRECT(BASE);
	let out = src.replace(ABS_RE, (_m, q, p) => `${q}${BASE}${p}`);
	if (file.includes('/cic/')) out = out.replace(CIC_CSS_ESCAPE_RE, (_m, q) => `url(${q}../../`);
	if (file.includes('/site/')) out = out.replace(SITE_EARLY_RE, (_m, q) => `url(${q}${BASE}/site/early-access/`);
	if (file.endsWith('/site/login.html')) out = out.replace(SITE_LOGIN_BETA, SITE_LOGIN_FIX);
	if (file.endsWith('.html')) out = out.replace(HTML_ROUTE_RE, (_m, a, r) => `${a}="${BASE}/${r}"`);
	return out;
}

function* jsFiles(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* jsFiles(p);
		else if (/\.(js|css|html)$/.test(e.name)) yield p;
	}
}

let patched = 0;
let sawGate = false;
let assetPatched = 0;
for (const file of jsFiles('build')) {
	let src = readFileSync(file, 'utf8');
	const fixed = patchJsCss(src, file);
	if (fixed !== src) {
		writeFileSync(file, fixed);
		assetPatched++;
		src = fixed;
	}
	if (!file.includes('/cic/')) continue;
	if (src.includes(CAM_DENY_MARKER)) {
		if (src.includes(CAM_DENY_TAIL)) {
			writeFileSync(file, src.replace(CAM_DENY_TAIL, CAM_DENY_FIX));
			src = readFileSync(file, 'utf8');
			console.log(`[patch-pages] camera-deny dialog fix applied in ${file}`);
		} else if (!src.includes(CAM_DENY_FIX)) {
			console.warn(`[patch-pages] device-check chunk changed — camera-deny fix anchor missing in ${file}`);
		}
	}
	if (src.includes(REPLACEMENT)) { sawGate = true; continue; } // already patched
	if (!src.includes(MARKER)) continue;
	sawGate = true;
	const count = src.split(THROW_TAIL).length - 1;
	if (!count) {
		console.error(`[patch-pages] marker present but throw/return tail not found in ${file}`);
		process.exit(1);
	}
	writeFileSync(file, src.replaceAll(THROW_TAIL, REPLACEMENT));
	patched += count;
	console.log(`[patch-pages] env gate neutralized in ${file} (${count} site${count > 1 ? 's' : ''})`);
}
console.log(`[patch-pages] asset base refs fixed in ${assetPatched} files`);
if (!patched && !sawGate) {
	console.error('[patch-pages] environment gate not found — vendored bundle changed?');
	process.exit(1);
}
