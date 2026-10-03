import { describe, expect, it } from 'vitest';
import { isNative, nativeSpeechEndpoint, initDeepLinks } from './native';

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
});
