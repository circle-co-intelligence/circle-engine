<script lang="ts">
	/**
	 * /billing — the account dashboard prod's "Open billing dashboard"
	 * button lands on (dashboardUrl → origin). Bearer-account billing:
	 * the browser-local accountId is the credential; Stripe owns the
	 * card data, receipts and subscription lifecycle via its portal.
	 */
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import {
		localAccount, ensureAccount, billingConfigured, billingConfig, billingAccount,
		checkoutUrl, portalUrl, sponsorRoom,
		type BillingAccount, type PayPack, type PaySub
	} from '$lib/bridge/account';

	let account = $state<{ accountId: string } | null>(null);
	let wallet = $state<BillingAccount | null>(null);
	let packs = $state<PayPack[]>([]);
	let sub = $state<PaySub | null>(null);
	let banner = $state<'ok' | 'canceled' | null>(null);
	let busy = $state(false);
	let error = $state('');
	let sponsorCode = $state('');
	let showRecovery = $state(false);

	onMount(async () => {
		account = localAccount();
		const q = new URL(location.href).searchParams;
		if (q.get('checkout') === 'ok') banner = 'ok';
		else if (q.get('checkout') === 'canceled') banner = 'canceled';
		if (!billingConfigured()) return;
		const cfg = await billingConfig();
		packs = cfg.packages;
		sub = cfg.subscription;
		if (account) wallet = await billingAccount();
	});

	function fmtSeconds(s: number): string {
		const h = Math.floor(s / 3600);
		const m = Math.round((s % 3600) / 60);
		return h ? `${h}h ${m}m` : `${m}m`;
	}
	function money(p: { amountCents?: number; currency?: string }): string {
		if (!p.amountCents) return '';
		return new Intl.NumberFormat('en', {
			style: 'currency',
			currency: (p.currency ?? 'usd').toUpperCase()
		}).format(p.amountCents / 100);
	}

	async function buy(kind: 'pack' | 'sub', packId?: string) {
		busy = true;
		error = '';
		try {
			const url = await checkoutUrl(kind, packId ? { packId } : {});
			if (!url) throw new Error('checkout unavailable');
			location.href = url; // Stripe-hosted checkout — PCI stays theirs
		} catch {
			error = 'Could not start checkout. Check billing is configured.';
		} finally {
			busy = false;
		}
	}

	async function manage() {
		busy = true;
		try {
			const url = await portalUrl();
			if (url) location.href = url;
			else error = 'No billing account yet — make a purchase first.';
		} finally {
			busy = false;
		}
	}

	async function toggleSponsor(room: string, on: boolean) {
		if (!(await sponsorRoom(room, on))) {
			error = 'Sponsorship needs a funded balance.';
			return;
		}
		wallet = await billingAccount();
	}

	function createAccount() {
		account = ensureAccount();
	}
</script>

<svelte:head><title>Billing — Co-Intelligence Circle</title></svelte:head>

<main class="shell">
	<div class="card">
		<h1>Billing</h1>

		{#if banner === 'ok'}
			<p class="banner ok">Payment received — your balance credits automatically once Stripe confirms. Refresh in a few seconds.</p>
		{:else if banner === 'canceled'}
			<p class="banner">Checkout canceled — nothing was charged.</p>
		{/if}

		{#if !billingConfigured()}
			<p class="dim">Payments aren't configured on this deployment yet.</p>
		{:else if !account}
			<p>Your billing identity is a private account key that lives in this browser — no sign-up, no email on our servers. Stripe handles the card side.</p>
			<button onclick={createAccount}>Create billing account</button>
		{:else}
			<dl class="wallet">
				<div><dt>Balance</dt><dd>{wallet ? fmtSeconds(wallet.balanceSeconds) : '…'}</dd></div>
				<div><dt>Spent</dt><dd>{wallet ? fmtSeconds(wallet.spentSeconds) : '…'}</dd></div>
				{#if wallet?.subscription}
					<div><dt>Subscription</dt><dd>
						{wallet.subscription.status}
						{wallet.subscription.cancelAtPeriodEnd ? ' (ends at period)' : ''}
						{#if wallet.subscription.currentPeriodEnd}
							— renews {new Date(wallet.subscription.currentPeriodEnd).toLocaleDateString()}
						{/if}
					</dd></div>
				{/if}
			</dl>

			{#if sub}
				<h2>Subscription</h2>
				<div class="pack">
					<div><strong>{sub.label}</strong><span class="dim">{fmtSeconds(sub.seconds)}/month{money(sub) ? ` — ${money(sub)}` : ''}</span></div>
					{#if wallet?.subscription?.status === 'active'}
						<button class="ghost" onclick={manage} disabled={busy}>Manage</button>
					{:else}
						<button onclick={() => buy('sub')} disabled={busy}>Subscribe</button>
					{/if}
				</div>
			{/if}

			{#if packs.length}
				<h2>Credit packs</h2>
				{#each packs as p (p.id)}
					<div class="pack">
						<div><strong>{p.label}</strong><span class="dim">{money(p) ? ` — ${money(p)}` : ''}</span></div>
						<button onclick={() => buy('pack', p.id)} disabled={busy}>Buy</button>
					</div>
				{/each}
			{/if}

			{#if wallet?.customerId}
				<button class="ghost" onclick={manage} disabled={busy}>Manage payment methods & invoices</button>
			{/if}

			<h2>Cover a circle</h2>
			<p class="dim">When you host, you can pay everyone's paid-lane usage from your balance.</p>
			<div class="sponsor-row">
				<input placeholder="room code" bind:value={sponsorCode} />
				<button class="ghost" onclick={() => toggleSponsor(sponsorCode.trim(), true)} disabled={!sponsorCode.trim()}>Cover</button>
			</div>
			{#if wallet?.sponsoredRooms?.length}
				{#each wallet.sponsoredRooms as r (r)}
					<div class="pack"><span>Sponsoring <strong>{r}</strong></span>
					<button class="ghost" onclick={() => toggleSponsor(r, false)}>Stop</button></div>
				{/each}
			{/if}

			<h2>Account key</h2>
			<p class="dim">This key is your billing identity — it lives only in this browser. Save it somewhere safe to recover your balance on another device.</p>
			{#if showRecovery}
				<code class="recovery">{account.accountId}</code>
			{:else}
				<button class="ghost" onclick={() => (showRecovery = true)}>Reveal account key</button>
			{/if}
		{/if}

		{#if error}<p class="banner err">{error}</p>{/if}
		<p class="dim back"><a href="{base}/">← Back to circles</a></p>
	</div>
</main>

<style>
	.shell { min-height: 100dvh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f6f3ee; padding: 1rem; }
	.card { background: #fff; border: 1px solid #e4ded2; border-radius: 16px; padding: 2rem; max-width: 480px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
	h1 { font-size: 1.4rem; margin: 0 0 1rem; }
	h2 { font-size: 1rem; margin: 1.5rem 0 0.5rem; }
	.dim { color: #5a554a; font-size: 0.9rem; }
	.wallet { display: grid; gap: 0.5rem; margin: 0 0 1rem; }
	.wallet div { display: flex; justify-content: space-between; }
	.wallet dt { color: #5a554a; } .wallet dd { margin: 0; font-weight: 600; }
	.pack { display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0; border-bottom: 1px solid #eee7da; gap: 0.75rem; }
	.pack .dim { display: block; }
	.sponsor-row { display: flex; gap: 0.5rem; }
	input { flex: 1; padding: 0.6rem; border: 1px solid #e4ded2; border-radius: 8px; font: inherit; }
	button { padding: 0.6rem 1.1rem; border: 0; border-radius: 10px; background: #1f4d3a; color: #fff; font-weight: 600; cursor: pointer; }
	button:disabled { opacity: 0.5; cursor: default; }
	button.ghost { background: transparent; color: #1f4d3a; border: 1px solid #1f4d3a; }
	.banner { padding: 0.6rem 0.9rem; border-radius: 8px; background: #f0ead9; }
	.banner.ok { background: #dff0e2; } .banner.err { background: #f6dcd8; }
	.recovery { display: block; word-break: break-all; background: #f6f3ee; padding: 0.75rem; border-radius: 8px; font-size: 0.8rem; }
	.back { margin-top: 1.5rem; }
	a { color: #1f4d3a; }
</style>
