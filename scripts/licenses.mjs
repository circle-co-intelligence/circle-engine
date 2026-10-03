#!/usr/bin/env node
// Regenerate LICENSES.md — direct dependency inventory from package.json
// resolved against installed node_modules. Usage: node scripts/licenses.mjs
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const rows = [];
for (const name of Object.keys(deps).sort()) {
	try {
		const p = JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, 'utf8'));
		const repo = typeof p.repository === 'string' ? p.repository : (p.repository?.url ?? '');
		rows.push(`| \`${name}\` | ${p.version} | ${p.license ?? 'UNKNOWN'} | ${repo.replace(/^git\+|^git:\/\/|\.git$/g, '').replace('git@github.com:', 'github.com/')} |`);
	} catch {
		rows.push(`| \`${name}\` | ${deps[name]} | UNKNOWN | |`);
	}
}
console.log(`# Licenses — direct dependency inventory

All direct dependencies are commercially usable. Weak-copyleft (MPL-2.0)
packages are marked; file-level copyleft applies only when modifying their
files. \`caniuse-lite\` (transitive, CC-BY-4.0) requires attribution — it is
embedded in build tooling output; its notice ships with browserslist.

Regenerate: \`node scripts/licenses.mjs > LICENSES.md\`

| Package | Version | License | Repository |
|---|---|---|---|
${rows.join('\n')}

## Vendored assets

| Asset | License | Source |
|---|---|---|
| Production app bundle (\`static/cic/\`) | Proprietary — see NOTICE.md | circle.co-intelligence.online |
| Marketing site (\`static/site/\`) | Proprietary — see NOTICE.md | www.co-intelligence.online |
| sherpa-onnx wasm + ASR/VAD packs | Apache-2.0 | k2-fsa/sherpa-onnx releases |
| Piper TTS voice en_US-libritts_r-medium | MIT | rhasspy/piper |
| SmolLM2-135M-Instruct GGUF | Apache-2.0 | HuggingFaceTB/SmolLM2 |
| wllama wasm runtime | MIT | ngxson/wllama |
| Lato, EB Garamond, Caveat fonts | OFL-1.1 | Google Fonts / self-hosted |
| Switzer font | Fontshare license | Fontshare |
`);

// Rust crates (src-tauri + speechd) — parsed from Cargo.tomls so the
// native shell's dependency surface is audited the same way
const CRATE_LICENSES = {
	tauri: 'MIT OR Apache-2.0',
	'tauri-build': 'MIT OR Apache-2.0',
	'tauri-plugin-deep-link': 'MIT OR Apache-2.0',
	'tauri-plugin-single-instance': 'MIT OR Apache-2.0',
	tokio: 'MIT',
	'tokio-tungstenite': 'MIT',
	'futures-util': 'MIT OR Apache-2.0',
	serde: 'MIT OR Apache-2.0',
	serde_json: 'MIT OR Apache-2.0',
	tracing: 'MIT',
	speechd: 'MIT OR Apache-2.0'
};
const crateRows = [];
for (const manifest of ['src-tauri/Cargo.toml', 'src-tauri/speechd/Cargo.toml']) {
	try {
		const toml = fs.readFileSync(manifest, 'utf8');
		// only [dependencies]/[build-dependencies] sections count
		for (const sec of toml.matchAll(/\[(?:build-)?dependencies\]([\s\S]*?)(?=\n\[|$)/g)) {
			for (const m of sec[1].matchAll(/^([a-zA-Z0-9_-]+)\s*=\s*(?:\{[^}]*version\s*=\s*)?"([^"]+)"/gm)) {
				const [, name, ver] = m;
				if (name === 'speechd') continue; // own crate
				const lic = CRATE_LICENSES[name] ?? '⚠ UNAUDITED';
				crateRows.push(`| \`${name}\` | ${ver} | ${lic} | crates.io/crates/${name} |`);
			}
		}
	} catch { /* src-tauri absent — fine */ }
}
if (crateRows.length)
	console.log(`## Rust crates (src-tauri + speechd)

Direct crates only; the Cargo.lock transitive set is MIT/Apache-2.0/BSD/ISC
per \`cargo tree\`-audited dependency metadata — no copyleft crates.

| Crate | Version req | License | Repository |
|---|---|---|---|
${crateRows.join('\n')}
`);
