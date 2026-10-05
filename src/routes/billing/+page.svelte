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
		checkoutUrl, portalUrl, sponsorRoom, deviceLinkBegin, deviceLinkStatus,
		deviceLinkApprove, deviceRevoke, setLinkedAccount, passkeyRegister,
		setSpendCap,
		type BillingAccount, type PayPack, type PaySub
	} from '$lib/bridge/account';
	import { passkeysSupported } from '$lib/crypto/accountKey';

	let account = $state<{ accountId: string } | null>(null);
	let wallet = $state<BillingAccount | null>(null);
	let packs = $state<PayPack[]>([]);
	let sub = $state<PaySub | null>(null);
	let banner = $state<'ok' | 'canceled' | null>(null);
	let busy = $state(false);
	let error = $state('');
	let sponsorCode = $state('');
	let sponsorHours = $state('4');
	let showRecovery = $state(false);
	let approveCode = $state('');
	let linkCode = $state('');
	let linkState = $state<'idle' | 'waiting' | 'linked'>('idle');
	let capHours = $state('');

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
		const hours = Math.max(0.1, Math.min(24, Number(sponsorHours) || 4));
		if (!(await sponsorRoom(room, on, Math.round(hours * 3600)))) {
			error = 'Sponsorship needs a funded balance and your device key.';
			return;
		}
		wallet = await billingAccount();
	}

	async function createAccount() {
		account = await ensureAccount();
	}

	// ---- device linking ----------------------------------------------------
	// this device (has the account): approve a code another device is showing
	async function approve() {
		const r = await deviceLinkApprove(approveCode.trim().toLowerCase());
		if (!r.ok) {
			error = 'Approval failed — check the code and try again.';
			return;
		}
		approveCode = '';
		wallet = await billingAccount();
	}

	// this device (new, no account): park its key and show a code
	async function beginLink() {
		busy = true;
		try {
			const code = await deviceLinkBegin();
			if (!code) {
				error = 'Could not reach billing — try again.';
				return;
			}
			linkCode = code;
			linkState = 'waiting';
			const until = Date.now() + 10 * 60_000;
			while (linkState === 'waiting' && Date.now() < until) {
				await new Promise((r) => setTimeout(r, 2500));
				const accountId = await deviceLinkStatus(code);
				if (accountId) {
					setLinkedAccount(accountId);
					account = { accountId };
					linkState = 'linked';
					wallet = await billingAccount();
					break;
				}
			}
			if (linkState === 'waiting') linkState = 'idle';
		} finally {
			busy = false;
		}
	}

	async function revoke(keyHash: string) {
		if (!(await deviceRevoke(keyHash))) {
			error = 'Revoke failed — needs your passkey if one is enrolled.';
			return;
		}
		wallet = await billingAccount();
	}

	// ---- passkey -----------------------------------------------------------
	async function enrollPasskey() {
		busy = true;
		try {
			if (!(await passkeyRegister(navigator.platform || 'this device'))) {
				error = 'Passkey enrollment was canceled or is unsupported here.';
				return;
			}
			wallet = await billingAccount();
		} finally {
			busy = false;
		}
	}

	// ---- spend cap ---------------------------------------------------------
	async function applyCap() {
		const h = parseFloat(capHours);
		const ok = await setSpendCap(Number.isFinite(h) && h > 0 ? Math.round(h * 3600) : null);
		if (!ok) {
			error = 'Could not update the spend cap.';
			return;
		}
		capHours = '';
		wallet = await billingAccount();
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
			<p>Your billing identity is a private key that lives only in this browser — no sign-up, no password, no email on our servers. Stripe handles the card side.</p>
			<button onclick={createAccount} disabled={busy}>Create billing account</button>
			<h2>Have an account on another device?</h2>
			{#if linkState === 'waiting'}
				<p>On your other device open <strong>Billing → Add a device</strong> and enter:</p>
				<code class="recovery linkcode">{linkCode}</code>
				<p class="dim">Waiting for approval… (10 min)</p>
			{:else if linkState === 'linked'}
				<p class="banner ok">Linked — this device now shares that account's balance.</p>
			{:else}
				<button class="ghost" onclick={beginLink} disabled={busy}>Link this device to it</button>
			{/if}
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
				<input class="cap-input" type="number" min="0.5" max="24" step="0.5" bind:value={sponsorHours} title="max hours to cover" />
				<button class="ghost" onclick={() => toggleSponsor(sponsorCode.trim(), true)} disabled={!sponsorCode.trim()}>Cover up to {sponsorHours || 4}h</button>
			</div>
			<p class="dim">Capped coverage — the server can only ever spend the budget you commit here.</p>
			{#if wallet?.sponsoredRooms?.length}
				{#each wallet.sponsoredRooms as r (r)}
					{@const rec = wallet?.sponsored?.[r]}
					<div class="pack"><span>Sponsoring <strong>{r}</strong>{typeof rec === 'object' && rec?.budget ? ` — ${fmtSeconds(rec.spent ?? 0)}/${fmtSeconds(rec.budget)} used` : ''}</span>
					<button class="ghost" onclick={() => toggleSponsor(r, false)}>Stop</button></div>
				{/each}
			{/if}

			<h2>Devices</h2>
			<p class="dim">Each device holds its own private key — approved by an existing device, revocable anytime. Losing your only device loses the balance.</p>
			{#each wallet?.devices ?? [] as d (d.keyHash)}
				<div class="pack">
					<span><code>{d.keyHash.slice(0, 12)}…</code>{d.primary ? ' (this identity)' : ''}</span>
					{#if !d.primary}
						<button class="ghost" onclick={() => revoke(d.keyHash)}>Revoke</button>
					{/if}
				</div>
			{/each}
			<div class="sponsor-row">
				<input placeholder="code shown on the new device" bind:value={approveCode} />
				<button class="ghost" onclick={approve} disabled={!approveCode.trim()}>Approve device</button>
			</div>

			<h2>Passkey</h2>
			{#if wallet?.passkeys?.length}
				<p class="dim">Sensitive actions (portal, device approval, large transfers) require this device's biometric/PIN.</p>
				{#each wallet.passkeys as p (p.credId)}
					<div class="pack"><span>{p.name ?? 'passkey'}</span><span class="dim">enrolled</span></div>
				{/each}
			{:else if passkeysSupported()}
				<p class="dim">Optional: require a fingerprint/face/PIN for sensitive actions.</p>
				<button class="ghost" onclick={enrollPasskey} disabled={busy}>Enable passkey protection</button>
			{:else}
				<p class="dim">Passkeys aren't supported on this device.</p>
			{/if}

			<h2>Spend cap</h2>
			<p class="dim">
				Optional daily limit on paid-lane spend from this wallet
				{wallet?.limits?.maxSecondsPerDay ? ` — currently ${fmtSeconds(wallet.limits.maxSecondsPerDay)}/day` : ' (off)'}.
			</p>
			<div class="sponsor-row">
				<input placeholder="hours per day, e.g. 4" bind:value={capHours} inputmode="decimal" />
				<button class="ghost" onclick={applyCap} disabled={!capHours.trim()}>Set cap</button>
				{#if wallet?.limits?.maxSecondsPerDay}
					<button class="ghost" onclick={() => { capHours = ' '; void setSpendCap(null).then(async () => (wallet = await billingAccount())); }}>Remove</button>
				{/if}
			</div>

			{#if wallet?.activity?.length}
				<h2>Recent activity</h2>
				{#each wallet.activity.slice(0, 15) as a, i (i)}
					<div class="pack">
						<span>{a.op}{a.detail ? ` — ${a.detail}` : ''}</span>
						<span class="dim">{a.device} · {new Date(a.at).toLocaleDateString()}</span>
					</div>
				{/each}
			{/if}

			<h2>Account</h2>
			<p class="dim">Public account id (safe to show — spending requires this device's private key).</p>
			{#if showRecovery}
				<code class="recovery">{account.accountId}</code>
			{:else}
				<button class="ghost" onclick={() => (showRecovery = true)}>Show account id</button>
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
	.cap-input { flex: 0 0 4.5rem; }
	button { padding: 0.6rem 1.1rem; border: 0; border-radius: 10px; background: #1f4d3a; color: #fff; font-weight: 600; cursor: pointer; }
	button:disabled { opacity: 0.5; cursor: default; }
	button.ghost { background: transparent; color: #1f4d3a; border: 1px solid #1f4d3a; }
	.banner { padding: 0.6rem 0.9rem; border-radius: 8px; background: #f0ead9; }
	.banner.ok { background: #dff0e2; } .banner.err { background: #f6dcd8; }
	.recovery { display: block; word-break: break-all; background: #f6f3ee; padding: 0.75rem; border-radius: 8px; font-size: 0.8rem; }
	.linkcode { font-size: 1.6rem; letter-spacing: 0.15em; text-align: center; }
	.back { margin-top: 1.5rem; }
	a { color: #1f4d3a; }
</style>
