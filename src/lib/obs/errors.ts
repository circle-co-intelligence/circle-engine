/**
 * errors.ts — opt-in error monitoring via a Sentry-compatible DSN
 * (GlitchTip self-hosted recommended — MIT). Inert unless
 * VITE_CIC_ERROR_DSN is set: the SDK lazy-loads so free/private installs
 * never even fetch it. No session replay, no PII scrubbing needed — we
 * strip everything at init (no user data, no room names, no URLs).
 */
export async function initErrorMonitoring(): Promise<void> {
	const dsn = (import.meta.env as Record<string, string | undefined>).VITE_CIC_ERROR_DSN;
	if (!dsn || typeof window === 'undefined') return;
	try {
		const Sentry = await import('@sentry/browser');
		Sentry.init({
			dsn,
			sendDefaultPii: false,
			enableLogs: false,
			tracesSampleRate: 0,
			beforeSend(ev) {
				delete ev.user;
				delete ev.request?.url;
				delete ev.request?.headers;
				return ev;
			}
		});
	} catch {
		/* monitoring must never break the app */
	}
}
