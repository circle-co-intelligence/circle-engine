import { describe, expect, it } from 'vitest';
import { isNative, nativeSpeechEndpoint, initDeepLinks, deepLinkTarget } from './native';

describe('native seams', () => {
	it('isNative is false outside the Tauri webview', () => {
		expect(isNative()).toBe(false);
	});

	it('speech endpoint resolves null in a browser', async () => {
		expect(await nativeSpeechEndpoint()).toBeNull();
	});

	it('deep-link init is a no-op in a browser', () => {
		expect(() => initDeepLinks()).not.toThrow();
	});

	it('isNative detects the injected bridge', () => {
		(globalThis as Record<string, unknown>).window = { __TAURI_INTERNALS__: {} };
		expect(isNative()).toBe(true);
		delete (globalThis as Record<string, unknown>).window;
	});

	it('maps circle:// urls preserving host segment, query, and fragment', () => {
		// circle://room/184729?x=1#secret → /room/184729?x=1#secret —
		// in a scheme URL the first path segment parses as the host
		expect(deepLinkTarget('circle://room/184729#abc')).toBe('/room/184729#abc');
		expect(deepLinkTarget('circle://room/934707?name=NativePeer')).toBe(
			'/room/934707?name=NativePeer'
		);
		expect(deepLinkTarget('circle:///join?code=123456')).toBe('/join?code=123456');
		expect(deepLinkTarget('circle://join?code=123456')).toBe('/join?code=123456');
	});
});
