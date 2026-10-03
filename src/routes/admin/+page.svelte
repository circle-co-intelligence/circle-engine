<script lang="ts">
	/**
	 * Enterprise console — room spend overview + grant minting.
	 * Only functional behind Cloudflare Access (the gateway verifies the
	 * Access JWT; without CF_ACCESS_TEAM the endpoints 503 and this page
	 * shows the closed state). Pseudonymous by design: room codes + seconds,
	 * never participant identity or content.
	 */
	import { onMount } from 'svelte';

	const GW = (import.meta.env.VITE_CIC_AI_ENDPOINT as string | undefined) ??
		'https://cic-ai-gateway.terexmaps.workers.dev';

	type Phase = 'loading' | 'unconfigured' | 'denied' | 'ready';
	interface RoomRow {
		balanceSeconds: number | null;
		spentSeconds: number | null;
		lastSeen: number;
	}

	let phase: Phase = $state('loading');
	let user = $state('');
	let rooms: Record<string, RoomRow> = $state({});
	let mintRoom = $state('');
	let mintSeconds = $state(3600);
	let minted = $state('');
	let err = $state('');

	async function load() {
		const res = await fetch(`${GW}/admin/overview`);
		if (res.status === 503) { phase = 'unconfigured'; return; }
		if (res.status === 403) { phase = 'denied'; return; }
		const body = await res.json();
		rooms = body.rooms ?? {};
		user = body.user ?? '';
		phase = 'ready';
	}

	async function mint() {
		err = '';
		minted = '';
		const res = await fetch(`${GW}/admin/mint`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ room: mintRoom, seconds: mintSeconds })
		});
		const body = await res.json();
		if (!res.ok) { err = body.error ?? `http ${res.status}`; return; }
		minted = body.grant;
		void load();
	}

	const ago = (ts: number) => `${Math.max(0, Math.round((Date.now() - ts) / 60000))}m ago`;
	onMount(load);
</script>

<svelte:head><title>CIC — console</title></svelte:head>

<div class="console">
	<h1>Circle console</h1>
	{#if phase === 'loading'}<p>Loading…</p>
	{:else if phase === 'unconfigured'}
		<p>Console unconfigured — set <code>CF_ACCESS_TEAM</code>/<code>CF_ACCESS_AUD</code> on cic-ai-gateway and front it with a Cloudflare Access application.</p>
	{:else if phase === 'denied'}
		<p>Access denied — the Access JWT was missing, expired, or for a different application.</p>
	{:else}
		<p class="who">Signed in via Cloudflare Access{user ? ` — ${user}` : ''}</p>
		<h2>Metered rooms</h2>
		{#if Object.keys(rooms).length === 0}
			<p>No metered activity yet.</p>
		{:else}
			<table>
				<thead><tr><th>room</th><th>balance</th><th>spent</th><th>last seen</th></tr></thead>
				<tbody>
					{#each Object.entries(rooms) as [room, r]}
						<tr>
							<td><code>{room}</code></td>
							<td>{r.balanceSeconds ?? '—'}s</td>
							<td>{r.spentSeconds ?? '—'}s</td>
							<td>{ago(r.lastSeen)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
		<h2>Mint a top-up grant</h2>
		<div class="mint">
			<input bind:value={mintRoom} placeholder="room code" />
			<input bind:value={mintSeconds} type="number" min="60" max="86400" step="60" />
			<button onclick={mint}>mint</button>
		</div>
		{#if err}<p class="err">{err}</p>{/if}
		{#if minted}
			<p>Grant (paste into the room's top-up chip):</p>
			<code class="grant">{minted}</code>
		{/if}
	{/if}
</div>

<style>
	.console { font: 14px/1.5 system-ui, sans-serif; color: #d7dde3; background: #14171c; min-height: 100vh; padding: 2rem; }
	h1 { font-size: 1.4rem; } h2 { font-size: 1.05rem; margin-top: 1.5rem; }
	.who { color: #7f8a94; }
	table { border-collapse: collapse; }
	td, th { border: 1px solid #2a3139; padding: .35rem .7rem; text-align: left; }
	.mint { display: flex; gap: .5rem; }
	input, button { background: #1d222a; color: inherit; border: 1px solid #2a3139; border-radius: 6px; padding: .4rem .6rem; }
	.err { color: #e07878; }
	.grant { display: block; word-break: break-all; background: #1d222a; padding: .6rem; border-radius: 6px; }
</style>
