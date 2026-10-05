/**
 * Native shell (Tauri) seams — all no-ops in a plain browser.
 *
 * - `nativeSpeechEndpoint()` returns the in-process speechd RT endpoint so
 *   the sensory lane can transcribe without audio leaving the device.
 * - `initDeepLinks()` hands `circle://…` launches to the running app —
 *   `circle://room/184729#secret` lands in the room like a web link.
 */

export function isNative(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** ws://127.0.0.1:<port> of the shell's local RT speech endpoint, or null */
export async function nativeSpeechEndpoint(): Promise<string | null> {
	if (!isNative()) return null;
	try {
		const { invoke } = await import('@tauri-apps/api/core');
		const ep = await invoke<string>('speech_endpoint');
		return typeof ep === 'string' && ep.startsWith('ws://') ? ep : null;
	} catch {
		return null;
	}
}

/**
 * `circle://room/184729#secret` → `/room/184729#secret`. In a custom-scheme
 * URL the resource's first segment parses as the host, so rejoin
 * host+pathname+search+fragment.
 */
export function deepLinkTarget(raw: string): string | null {
	try {
		const u = new URL(raw);
		const sub = u.pathname === '/' ? '' : u.pathname;
		const path = u.host ? `/${u.host}${sub}` : u.pathname;
		return `${path}${u.search}${u.hash}` || '/';
	} catch {
		return null;
	}
}

/** route `circle://` open-url events into the app's normal URL flow */
export function initDeepLinks(): void {
	if (!isNative()) return;
	void import('@tauri-apps/plugin-deep-link')
		.then(({ onOpenUrl }) =>
			onOpenUrl((urls) => {
				for (const raw of urls) {
					const target = deepLinkTarget(raw);
					if (
						target &&
						location.pathname + location.search + location.hash !== target
					)
						location.assign(target);
				}
			})
		)
		.catch(() => {});
}
