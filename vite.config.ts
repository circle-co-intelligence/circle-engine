import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// crossOriginIsolated (SharedArrayBuffer for multi-threaded wllama/sherpa)
// needs COOP+COEP on every response — server.headers alone doesn't reach
// SvelteKit-rendered pages, so a middleware sets them unconditionally
const isolationHeaders = {
	name: 'cic-isolation-headers',
	configureServer(s: { middlewares: { use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
		s.middlewares.use((_req, res, next) => {
			res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
			res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
			next();
		});
	},
	configurePreviewServer(s: { middlewares: { use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
		s.middlewares.use((_req, res, next) => {
			res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
			res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
			next();
		});
	}
};

export default defineConfig({
	plugins: [isolationHeaders, sveltekit()],
	server: {
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp'
		}
	},
	preview: {
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp'
		}
	},
	test: {
		include: ['src/**/*.test.ts', 'workers/**/*.test.ts']
	}
});
