/**
 * invite.ts — .ics calendar invites for scheduled circles (ics package, MIT).
 * The room secret stays in the URL fragment — the .ics carries the join URL
 * only; it's as sensitive as the invite link itself (share carefully).
 */
import { createEvent } from 'ics';

export function icsInvite(opts: {
	title: string;
	startAt: Date;
	minutes: number;
	joinUrl: string;
	description?: string;
}): string {
	const end = new Date(opts.startAt.getTime() + opts.minutes * 60_000);
	const ev = createEvent({
		title: opts.title,
		start: dateTuple(opts.startAt),
		end: dateTuple(end),
		description: `${opts.description ?? 'Co-Intelligence Circle'}\n\nJoin: ${opts.joinUrl}`,
		url: opts.joinUrl
	});
	if (ev.error || !ev.value) throw ev.error ?? new Error('ics generation failed');
	return ev.value;
}

/** download the invite as a file — used by the host's schedule/share UX */
export function downloadIcs(filename: string, icsText: string) {
	const blob = new Blob([icsText], { type: 'text/calendar' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

/**
 * Email delivery — POSTs the .ics + recipients to a configured relay
 * (VITE_CIC_INVITE_RELAY — e.g. a Resend/SES-backed endpoint the operator
 * runs; we don't ship a mail provider). Unset → false, caller falls back
 * to downloadIcs.
 */
export async function emailInvite(icsText: string, to: string[]): Promise<boolean> {
	const relay = (import.meta.env as Record<string, string | undefined>).VITE_CIC_INVITE_RELAY;
	if (!relay || !to.length) return false;
	try {
		const res = await fetch(relay, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ to, filename: 'invite.ics', ics: icsText })
		});
		return res.ok;
	} catch {
		return false;
	}
}

function dateTuple(d: Date): [number, number, number, number, number] {
	return [
		d.getUTCFullYear(),
		d.getUTCMonth() + 1,
		d.getUTCDate(),
		d.getUTCHours(),
		d.getUTCMinutes()
	];
}
