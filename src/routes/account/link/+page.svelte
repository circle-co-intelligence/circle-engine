<script lang="ts">
	/**
	 * /account/link — the local target of prod's account-link loginUrl.
	 * The room tab sent account-link-start and polls every 2s; this page
	 * resolves the challenge in localStorage, which completeLink() writes and
	 * pollLink() (in the room tab) picks up → account-linked{accountId}.
	 */
	import { onMount } from 'svelte';
	import { completeLink, deviceLinkApprove, localAccount } from '$lib/bridge/account';

	let phase = $state<'confirm' | 'done' | 'invalid' | 'approve' | 'approved' | 'fail'>('confirm');
	let challengeId = '';
	let linkCode = $state('');

	onMount(() => {
		const q = new URL(location.href).searchParams;
		linkCode = q.get('k') ?? '';
		if (linkCode) {
			// device-delegation link: this device must already hold the account
			phase = localAccount() ? 'approve' : 'invalid';
			return;
		}
		challengeId = q.get('ch') ?? '';
		if (!challengeId) phase = 'invalid';
	});

	async function confirm() {
		phase = (await completeLink(challengeId)) ? 'done' : 'invalid';
	}

	async function approve() {
		const r = await deviceLinkApprove(linkCode.toLowerCase());
		phase = r.ok ? 'approved' : 'fail';
	}
</script>

<svelte:head><title>Link this device — Co-Intelligence Circle</title></svelte:head>

<main class="link-shell">
	<div class="link-card">
		{#if phase === 'approve'}
			<h1>Approve a new device</h1>
			<p>A device showing code <code>{linkCode}</code> is asking to share this account's billing wallet. Its private key stays on that device — you can revoke it later from Billing.</p>
			<button onclick={approve}>Approve device</button>
		{:else if phase === 'approved'}
			<h1>Device approved</h1>
			<p>The new device is linked and shares your balance. Manage or revoke it anytime under Billing → Devices.</p>
		{:else if phase === 'fail'}
			<h1>Approval failed</h1>
			<p>The code expired or the request couldn't be signed. Have the new device start again and retry.</p>
		{:else if phase === 'confirm'}
			<h1>Link this device</h1>
			<p>Create a local account identity and attach it to your circle session. Nothing leaves this device — the identity lives in this browser's storage.</p>
			<button onclick={confirm}>Link account</button>
		{:else if phase === 'done'}
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
