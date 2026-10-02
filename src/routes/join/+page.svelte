<script lang="ts">
	/** Local join entry — the SaaS dashboard doesn't exist here; this is the
	 * room-code + name gate that lands on /room/{code}#{secret}. */
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { onMount } from 'svelte';

	let name = $state('');
	let code = $state('');

	onMount(() => {
		// prod's exit view links back here as /join?code={code} — prefill it
		const q = new URL(location.href).searchParams;
		if (q.get('code')) code = q.get('code') ?? '';
		if (q.get('name')) name = q.get('name') ?? '';
		try { name ||= sessionStorage.getItem('cic.name') ?? ''; } catch {}
	});

	function join() {
		const c = code.replace(/\D/g, '').slice(0, 6) || Math.floor(100000 + Math.random() * 900000).toString();
		const params = new URLSearchParams();
		if (name.trim()) {
			params.set('name', name.trim());
			try { sessionStorage.setItem('cic.name', name.trim()); } catch {}
		}
		goto(`${base}/room/${c}?${params}#${crypto.randomUUID()}`);
	}
</script>

<svelte:head><title>Join a circle — Co-Intelligence Circle</title></svelte:head>

<main class="join-shell">
	<form class="join-card" onsubmit={(e) => { e.preventDefault(); join(); }}>
		<h1>Join a circle</h1>
		<label>
			Your name
			<input bind:value={name} placeholder="Ada" autocomplete="name" />
		</label>
		<label>
			Circle code <span class="hint">(blank opens a fresh circle)</span>
			<input bind:value={code} inputmode="numeric" placeholder="123456" />
		</label>
		<button type="submit">Join circle</button>
		<p><a href="{base}/">← Back</a></p>
	</form>
</main>

<style>
	.join-shell {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		font-family: system-ui, sans-serif;
		background: #f6f3ee;
	}
	.join-card {
		display: grid;
		gap: 1rem;
		background: #fff;
		border: 1px solid #e4ded2;
		border-radius: 16px;
		padding: 2rem;
		min-width: 320px;
		box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06);
	}
	h1 { font-size: 1.4rem; margin: 0; }
	label { display: grid; gap: 0.35rem; font-size: 0.9rem; font-weight: 500; }
	.hint { font-weight: 400; color: #8a8378; font-size: 0.8rem; }
	input {
		padding: 0.65rem 0.8rem;
		border: 1px solid #d8d2c4;
		border-radius: 10px;
		font-size: 1rem;
	}
	button {
		padding: 0.75rem;
		border: 0;
		border-radius: 10px;
		background: #1f4d3a;
		color: #fff;
		font-size: 1rem;
		font-weight: 600;
		cursor: pointer;
	}
	a { color: #1f4d3a; }
</style>
