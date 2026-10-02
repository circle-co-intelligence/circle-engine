<script lang="ts">
	/**
	 * /account/link — the local target of prod's account-link loginUrl.
	 * The room tab sent account-link-start and polls every 2s; this page
	 * resolves the challenge in localStorage, which completeLink() writes and
	 * pollLink() (in the room tab) picks up → account-linked{accountId}.
	 */
	import { onMount } from 'svelte';
	import { completeLink } from '$lib/bridge/account';

	let state = $state<'confirm' | 'done' | 'invalid'>('confirm');
	let challengeId = '';

	onMount(() => {
		challengeId = new URL(location.href).searchParams.get('ch') ?? '';
		if (!challengeId) state = 'invalid';
	});

	function confirm() {
		state = completeLink(challengeId) ? 'done' : 'invalid';
	}
</script>

<svelte:head><title>Link this device — Co-Intelligence Circle</title></svelte:head>

<main class="link-shell">
	<div class="link-card">
		{#if state === 'confirm'}
			<h1>Link this device</h1>
			<p>Create a local account identity and attach it to your circle session. Nothing leaves this device — the identity lives in this browser's storage.</p>
			<button onclick={confirm}>Link account</button>
		{:else if state === 'done'}
			<h1>Linked</h1>
			<p>This device is linked. You can close this tab — the circle tab picks it up automatically.</p>
		{:else}
			<h1>Link expired</h1>
			<p>This sign-in link expired or was already used. Start a new one from your circle tab.</p>
		{/if}
	</div>
</main>

<style>
	.link-shell {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		font-family: system-ui, sans-serif;
		background: #f6f3ee;
	}
	.link-card {
		background: #fff;
		border: 1px solid #e4ded2;
		border-radius: 16px;
		padding: 2rem;
		max-width: 380px;
		box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06);
	}
	h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
	p { color: #5a554a; line-height: 1.5; }
	button {
		padding: 0.75rem 1.25rem;
		border: 0;
		border-radius: 10px;
		background: #1f4d3a;
		color: #fff;
		font-size: 1rem;
		font-weight: 600;
		cursor: pointer;
	}
</style>
