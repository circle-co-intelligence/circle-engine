<script lang="ts">
	/**
	 * Ops replay viewer — masked session replays stored in cic-ux-replay.
	 * Gated on the UX_ADMIN bearer secret (wrangler secret on the Pages
	 * project); sessions are anonymous visit ids — no identity exists to
	 * show. The recorded DOM was already text-masked client-side; this
	 * viewer only assembles chunks and plays them back.
	 */
	import { onMount } from 'svelte';
	import { base } from '$app/paths';

	type SessionRow = { visit: string; status?: string; closedAt?: number };

	let token = $state('');
	let sessions = $state<SessionRow[]>([]);
	let cursor = $state<string | null>(null);
	let err = $state('');
	let active = $state('');
	let playerEl: HTMLElement | undefined = $state();
	let loading = $state(false);

	const KEY = 'cic.uxAdmin';
	onMount(() => {
		try {
			token = sessionStorage.getItem(KEY) ?? '';
		} catch {}
		if (token) void load();
	});

	async function api(path: string): Promise<Response> {
		return fetch(`${base}/api/ux/${path}`, {
			headers: { authorization: `Bearer ${token}` }
		});
	}

	async function load() {
		err = '';
		try {
			sessionStorage.setItem(KEY, token);
		} catch {}
		const r = await api(`admin/replay/sessions${cursor ? `?cursor=${cursor}` : ''}`);
		if (r.status === 403) {
			err = 'admin token rejected';
			return;
		}
		const body = (await r.json()) as { sessions: SessionRow[]; cursor: string | null };
		sessions = body.sessions;
		cursor = body.cursor;
	}

	async function play(visit: string) {
		err = '';
		active = visit;
		loading = true;
		playerEl?.replaceChildren();
		try {
			const events: unknown[] = [];
			for (let i = 0; i < 64; i++) {
				const r = await api(`admin/replay/chunk?visit=${visit}&index=${i}`);
				if (r.status === 404) break;
				if (!r.ok) throw new Error(`chunk ${i}: http ${r.status}`);
				events.push(...((await r.json()) as unknown[]));
			}
			if (!events.length) throw new Error('session has no chunks');
			const { default: Player } = await import('rrweb-player');
			await import('rrweb-player/dist/style.css');
			if (!playerEl) return;
			new Player({
				target: playerEl,
				props: {
					events: events as never[],
					width: Math.min(1200, innerWidth - 80),
					height: Math.min(700, innerHeight - 160),
					autoPlay: true
				}
			});
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	const fmt = (ts?: number) => (ts ? new Date(ts).toLocaleString() : '—');
</script>

<svelte:head><title>Replay — CIC ops</title></svelte:head>

<div class="ops">
	<h1>Session replays</h1>
	<p class="note">
		Masked DOM skeletons only — no text, inputs, media, names or room codes exist in this data.
		Retention: 30 days, deleted earlier on consent revocation.
	</p>
	{#if !token || err === 'admin token rejected'}
		<form
			class="gate"
			onsubmit={(e) => {
				e.preventDefault();
				void load();
			}}
		>
			<label>
				Admin token
				<input bind:value={token} type="password" autocomplete="off" />
			</label>
			<button type="submit">Open</button>
			{#if err}<p class="err">{err}</p>{/if}
		</form>
	{:else}
		{#if sessions.length}
			<ul class="sessions">
				{#each sessions as s (s.visit)}
					<li>
						<button class="row" onclick={() => void play(s.visit)}>
							<code>{s.visit.slice(0, 8)}</code>
							<span>{s.status ?? 'open'}</span>
							<span class="when">{fmt(s.closedAt)}</span>
						</button>
					</li>
				{/each}
			</ul>
			{#if cursor}<button onclick={() => void load()}>more</button>{/if}
		{:else}
			<p>No replay sessions yet.</p>
		{/if}
		{#if loading}<p>loading chunks…</p>{/if}
		{#if err}<p class="err">{err}</p>{/if}
		{#if active}
			<h2>replay <code>{active.slice(0, 8)}</code></h2>
			<div bind:this={playerEl} class="player"></div>
		{/if}
	{/if}
</div>

<style>
	.ops {
		max-width: 1280px;
		margin: 0 auto;
		padding: 2rem;
		font-family: system-ui, sans-serif;
	}
	.note {
		color: #667;
		font-size: 0.9rem;
	}
	.gate {
		display: flex;
		gap: 0.75rem;
		align-items: end;
	}
	label {
		display: grid;
		gap: 0.3rem;
		font-size: 0.85rem;
	}
	input {
		padding: 0.5rem;
		border: 1px solid #ccc;
		border-radius: 8px;
	}
	button {
		padding: 0.5rem 1rem;
		border: 0;
		border-radius: 8px;
		background: #1f4d3a;
		color: #fff;
		cursor: pointer;
	}
	.sessions {
		list-style: none;
		padding: 0;
		display: grid;
		gap: 0.4rem;
		max-width: 640px;
	}
	.row {
		display: flex;
		gap: 1rem;
		width: 100%;
		padding: 0.6rem 1rem;
		background: #f4f1ea;
		border: 1px solid #e2ddd0;
		border-radius: 10px;
		color: inherit;
		text-align: left;
	}
	.when {
		margin-left: auto;
		color: #667;
	}
	.err {
		color: #b91c1c;
	}
	.player {
		border: 1px solid #ddd;
		border-radius: 12px;
		overflow: hidden;
		width: fit-content;
	}
</style>
