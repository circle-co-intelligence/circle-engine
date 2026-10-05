<script lang="ts">
	/**
	 * /pricing — plan comparison the vendored app links to ("Compare plans").
	 * Free tier stays fully device-side; paid unlocks the Cloudflare lanes
	 * (SFU fanout, cloud AI, encrypted recording offload) metered in seconds.
	 */
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import {
		billingConfigured, billingConfig, checkoutUrl,
		type PayPack, type PaySub
	} from '$lib/bridge/account';

	let packs = $state<PayPack[]>([]);
	let sub = $state<PaySub | null>(null);
	let busy = $state(false);
	let error = $state('');

	onMount(async () => {
		if (!billingConfigured()) return;
		const cfg = await billingConfig();
		packs = cfg.packages;
		sub = cfg.subscription;
	});

	function money(p: { amountCents?: number; currency?: string }): string {
		if (!p.amountCents) return '';
		return new Intl.NumberFormat('en', {
			style: 'currency',
			currency: (p.currency ?? 'usd').toUpperCase()
		}).format(p.amountCents / 100);
	}
	function fmtSeconds(s: number): string {
		const h = Math.floor(s / 3600);
		const m = Math.round((s % 3600) / 60);
		return h ? `${h}h ${m}m` : `${m}m`;
	}
	async function buy(kind: 'pack' | 'sub', packId?: string) {
		busy = true;
		error = '';
		try {
			const url = await checkoutUrl(kind, packId ? { packId } : {});
			if (!url) throw new Error();
			location.href = url;
		} catch {
			error = 'Checkout unavailable — try the billing page.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Pricing — Co-Intelligence Circle</title></svelte:head>

<main class="shell">
	<div class="card">
		<h1>Pricing</h1>

		<div class="tier">
			<h2>Free</h2>
			<p class="dim">Peer-to-peer everything — mesh media, on-device captions, notes, local recording, E2EE. No account needed.</p>
			<p class="price">$0</p>
		</div>

		{#if sub}
			<div class="tier featured">
				<h2>{sub.label}</h2>
				<p class="dim">{fmtSeconds(sub.seconds)} of paid-lane credit every month — SFU fanout, cloud speech, encrypted recording offload. Follows you across every circle.</p>
				<p class="price">{money(sub)}/mo</p>
				<button onclick={() => buy('sub')} disabled={busy}>Subscribe</button>
			</div>
		{/if}

		{#if packs.length}
			<h2 class="sep">Or buy seconds once</h2>
			{#each packs as p (p.id)}
				<div class="pack">
					<div><strong>{p.label}</strong></div>
					<button onclick={() => buy('pack', p.id)} disabled={busy}>{money(p) || 'Buy'}</button>
				</div>
			{/each}
		{/if}

		{#if !billingConfigured()}
			<p class="dim">Payments aren't configured on this deployment yet.</p>
		{/if}
		{#if error}<p class="banner err">{error}</p>{/if}
		<p class="dim back"><a href="{base}/">← Back to circles</a> · <a href="{base}/billing">Billing dashboard</a></p>
	</div>
</main>

<style>
	.shell { min-height: 100dvh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f6f3ee; padding: 1rem; }
	.card { background: #fff; border: 1px solid #e4ded2; border-radius: 16px; padding: 2rem; max-width: 480px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
	h1 { font-size: 1.4rem; margin: 0 0 1rem; }
	h2 { font-size: 1.1rem; margin: 0 0 0.4rem; }
	.sep { font-size: 1rem; margin: 1.5rem 0 0.5rem; }
	.dim { color: #5a554a; font-size: 0.9rem; }
	.tier { border: 1px solid #e4ded2; border-radius: 12px; padding: 1rem; margin-bottom: 1rem; }
	.tier.featured { border-color: #1f4d3a; }
	.price { font-size: 1.5rem; font-weight: 700; margin: 0.5rem 0; }
	.pack { display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0; border-bottom: 1px solid #eee7da; }
	button { padding: 0.6rem 1.1rem; border: 0; border-radius: 10px; background: #1f4d3a; color: #fff; font-weight: 600; cursor: pointer; }
	button:disabled { opacity: 0.5; cursor: default; }
	.banner.err { background: #f6dcd8; padding: 0.6rem 0.9rem; border-radius: 8px; }
	.back { margin-top: 1.5rem; }
	a { color: #1f4d3a; }
</style>
