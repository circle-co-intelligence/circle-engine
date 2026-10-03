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

function patchJsCss(src, file = '') {
	let out = src.replace(ABS_RE, (_m, q, p) => `${q}${BASE}${p}`);
	if (file.includes('/cic/')) out = out.replace(CIC_CSS_ESCAPE_RE, (_m, q) => `url(${q}../../`);
	if (file.includes('/site/')) out = out.replace(SITE_EARLY_RE, (_m, q) => `url(${q}${BASE}/site/early-access/`);
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
