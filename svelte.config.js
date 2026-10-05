import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({ fallback: 'index.html' }),
		// ssr=false emits no crawlable HTML, so prerender entries must be
		// explicit — these routes ship as real files (200 on Pages) instead
		// of the 404-status fallback. Prod's invite links target /join?code=…
		prerender: { entries: ['*', '/join', '/account/link'] },
		// CIC_BASE: mount path for static hosts that serve under a prefix
		// (GitHub Pages project site → '/circle-engine'). Empty in dev/root deploys.
		paths: { base: process.env.CIC_BASE ?? '' },
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				// connect-src: same-origin + rendezvous relays (nostr/mqtt/bittorrent)
				// — all wss endpoints + model-pack remotes. GitHub release
				// downloads redirect to *.githubusercontent.com; HF LFS to
				// *.hf.co CDNs. The dotlottie CDN fetch is shimmed to the
				// vendored copy in install.ts. Loopback ws/http allows the
				// native shell's local speech service (and a user-run engine
				// for web clients) without opening insecure remote origins.
				'connect-src': [
					'self',
					'wss:',
					// blob: sherpa pack extraction + wllama blob-worker model
					// fetch — fetch() to blob: URLs is connect-src governed
					'blob:',
					'ws://localhost:*',
					'ws://127.0.0.1:*',
					'http://localhost:*',
					'http://127.0.0.1:*',
					// edge services the build scripts point at (entitlement/AI,
					// DSP relay, SFU) — fetch/WebSocket to these must pass CSP
					'https://cic-ai-gateway.regenleadership.workers.dev',
					'https://cic-dsp.regenleadership.workers.dev',
					'https://cic-sfu.regenleadership.workers.dev',
					'https://cic-pay.regenleadership.workers.dev',
					// consent-gated cookieless pageview hits (Counterscale worker)
					'https://cic-analytics.regenleadership.workers.dev',
					'wss://cic-signaling.regenleadership.workers.dev',
					'https://github.com',
					'https://*.githubusercontent.com',
					'https://huggingface.co',
					'https://*.hf.co'
				],
				// wasm-unsafe-eval: sherpa-onnx/opa-wasm/wllama instantiate WASM modules
				// blob:: sherpa scripts may be injected via blob URLs when packs are
				// fetched+extracted from upstream remotes instead of /models
				'script-src': ['self', 'wasm-unsafe-eval', 'blob:'],
				// style-src: Svelte transitions inject inline styles
				'style-src': ['self', 'unsafe-inline'],
				'worker-src': ['self', 'blob:'],
				'font-src': ['self'],
				'img-src': ['self', 'data:', 'blob:'],
				'media-src': ['self', 'blob:', 'mediastream:'],
				'object-src': ['none'],
				'base-uri': ['none'],
				'form-action': ['self']
			}
		}
	}
};

export default config;
