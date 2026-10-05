<script lang="ts">
	/**
	 * Landing — the vendored production marketing page
	 * (static/site/), rendered verbatim. Assets resolve
	 * under /site/*; the page's JS is stripped (hydration + gtag don't belong
	 * in a privacy-preserving build). "Log in" links to /join, our entry.
	 */
	import { onMount } from 'svelte';
	import { base } from '$app/paths';

	let markup = $state('');
	let host: HTMLElement;

	onMount(async () => {
		const html = await (await fetch(`${base}/site/index.html`)).text();
		const doc = new DOMParser().parseFromString(html, 'text/html');
		// the page's styles live in head links — hoist them into our head
		for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"], link[href*=".css"]')) {
			const el = document.createElement('link');
			el.rel = 'stylesheet';
			el.href = link.href;
			document.head.appendChild(el);
		}
		// inline style blocks too
		for (const style of doc.querySelectorAll('style'))
			document.head.appendChild(document.createElement('style')).textContent = style.textContent;
		markup = doc.body.innerHTML
			// authored additions (vendored file stays pristine):
			// pricing section + nav link, GitHub repo link in the footer
			.replace('<a href="#faq">FAQ</a>', '<a href="#pricing">Pricing</a><a href="#faq">FAQ</a>')
			.replace(
				'<a href="/site/imprint.html">Imprint</a>',
				'<a href="/site/imprint.html">Imprint</a><a href="https://github.com/circle-co-intelligence/circle-engine" rel="noopener" target="_blank">GitHub</a>'
			)
			.replace('<section class="ea-faq', `${PRICING}<section class="ea-faq`)
			// general availability — the vendored page still carries its
			// private-beta framing; rewrite it to the open release
			.replaceAll('Private beta: request early access.', 'Free, end-to-end encrypted group circles — open to everyone.')
			.replace(
				/<p class="ea-status ea-ms">[\s\S]*?<\/p>/,
				`<p class="ea-status ea-ms"><i aria-hidden="true"></i><span class="sr-only">Now available to everyone.</span><span class="ea-open-pill" aria-hidden="true">Open to everyone — start a circle free</span></p>`
			)
			.replace(
				'<a class="ea-btn ea-btn-dark" href="#request">Request early access</a>',
				`<a class="ea-btn ea-btn-dark" href="${base}/join">Start a circle — free</a>`
			)
			.replace(
				/<div class="ea-request" id="request">[\s\S]*?<\/form><\/div><\/div>/,
				`<div class="ea-request" id="request"><div class="ea-form"><a class="ea-btn ea-btn-dark ea-open-cta" href="${base}/join">Open a circle — free</a><p class="ea-fine ea-open-fine">No account, no download, no invite. The circle runs end-to-end encrypted in your browser — share the link or six-digit code and everyone joins free.</p></div></div>`
			)
			.replace(
				/<section class="ea-invite ea-shell"[\s\S]*?<\/section>/,
				INVITE
			)
			// FAQ — beta-gated answers rewritten for open availability
			.replace(
				'<summary><span>Is the beta available to everyone?</span><i class="ea-faq-icon" aria-hidden="true"></i></summary><div class="ea-faq-a"><p>Not yet. We invite people in small groups, so we can support each circle well and improve the product together with them.</p></div>',
				'<summary><span>Is it available to everyone?</span><i class="ea-faq-icon" aria-hidden="true"></i></summary><div class="ea-faq-a"><p>Yes — circles are open to everyone. Open the app, start a circle, and share the link or six-digit code. There is no waitlist.</p></div>'
			)
			.replace(
				'<summary><span>What happens after I apply?</span><i class="ea-faq-icon" aria-hidden="true"></i></summary><div class="ea-faq-a"><p>We review requests by hand. If we can offer you a place, we send a personal invitation to the email address you gave us. That invitation lets you create your account.</p></div>',
				'<summary><span>Do I need an account?</span><i class="ea-faq-icon" aria-hidden="true"></i></summary><div class="ea-faq-a"><p>No. A circle runs entirely in the browser — start one and everyone joins free with a link or code, no account on either side. An optional account only unlocks paid host extras like larger circles and cloud recordings.</p></div>'
			)
			.replace(
				'<p>Once you have access, your guests join free in their browser using a link or six-digit room code. Only the host needs an account.</p>',
				'<p>Your guests join free in their browser using a link or six-digit room code — no account and no install on either side.</p>'
			);
	});

	// Circle Host: $8/host undercuts Zoom Pro ($15.99), Butter Starter ($24/member),
	// Whereby Pro ($10.99). Free tier stays radically complete — zero servers means
	// near-zero marginal cost, so E2EE + local AI cost us nothing to give away.
	const PRICING = `
<section class="ea-pricing ea-shell" id="pricing" aria-labelledby="pricing-h">
	<div class="ea-pricing-head">
		<p class="ea-eyebrow">Pricing</p>
		<h2 id="pricing-h">Free where it matters.<br/>Paid where it scales.</h2>
		<p class="ea-lead">Every plan is end-to-end encrypted, account-free, and yours — the circle runs in your browser, not on our servers. Free is everything a circle needs. Host is everything a host wants.</p>
	</div>
	<div class="ea-pricing-grid">
		<article class="ea-price-card">
			<h3>Circle</h3>
			<p class="ea-price"><b>$0</b><span>forever</span></p>
			<p class="ea-price-note">The whole circle — no trial, no card, no account.</p>
			<ul>
				<li>Unlimited circles, no time limit</li>
				<li>Up to 9 seats around the fire</li>
				<li>End-to-end encryption, always on</li>
				<li>Room secret lives in your URL — never on a server</li>
				<li>Talking stick: Circle, Open &amp; question rounds</li>
				<li>Live captions, translation &amp; voice — on-device</li>
				<li>Milo, the AI companion — local models</li>
				<li>Recordings &amp; notes saved to your device</li>
				<li>Breakouts, lobby &amp; password gates</li>
			</ul>
			<a class="ea-price-cta ea-price-ghost" href="${base}/join">Open a circle — free</a>
		</article>
		<article class="ea-price-card ea-price-host">
			<p class="ea-price-badge">Most generous host plan on the market</p>
			<h3>Circle Host</h3>
			<p class="ea-price"><b>$8</b><span>/host · month · or $79/yr</span></p>
			<p class="ea-price-note">Everything in Free, plus:</p>
			<ul>
				<li>Up to 30 seats — managed relay mesh keeps video smooth</li>
				<li>Reserved circle codes &amp; persistent rooms</li>
				<li>Cloud recording vault with shareable replay links</li>
				<li>Larger model packs — fuller Milo, faster captions</li>
				<li>Custom branding — your logo, your fire</li>
				<li>Priority human support</li>
				<li>Early access to V2 rituals &amp; tools</li>
			</ul>
			<a class="ea-btn ea-price-cta" href="${base}/pricing">Become a host</a>
		</article>
	</div>
	<div class="ea-compare">
		<p class="ea-eyebrow">The honest math — monthly billing, per public pricing pages</p>
		<ul>
			<li><b>Zoom Pro</b><span>$15.99 / host / mo · E2EE optional, account required</span></li>
			<li><b>Butter Starter</b><span>$24 / member / mo · everyone pays, not just the host</span></li>
			<li><b>Whereby Pro</b><span>$10.99 / host / mo · free tier caps at 45 min</span></li>
			<li class="ea-compare-us"><b>Circle Host</b><span>$8 / host / mo · and Free is already E2EE, unlimited time</span></li>
		</ul>
	</div>
</section>`;

	// open-availability replacement for the vendored "Early access" invite
	// section — the request/review/invitation flow no longer exists
	const INVITE = `
<section class="ea-invite ea-shell" aria-labelledby="invite-h">
	<div class="ea-invite-copy">
		<p class="ea-eyebrow">Open to everyone</p>
		<h2 id="invite-h">What could your group understand together?</h2>
		<p>Bring your people into a circle. Give each voice time, listen deeply, and discover what takes shape between you. Circles are open to everyone — start one whenever you're ready.</p>
		<a class="ea-btn" href="${base}/join">Start a circle</a>
	</div>
	<div>
		<ol class="ea-steps">
			<li><span class="ea-step-rail" aria-hidden="true"><i></i></span><span class="ea-step-n" aria-hidden="true">1</span><div><strong>Start</strong><p>Open the app and start a circle — no account needed.</p></div></li>
			<li><span class="ea-step-rail" aria-hidden="true"><i></i></span><span class="ea-step-n" aria-hidden="true">2</span><div><strong>Share</strong><p>Send your people the link or six-digit code.</p></div></li>
			<li><span class="ea-step-n" aria-hidden="true">3</span><div><strong>Circle</strong><p>Everyone joins free in their browser, end-to-end encrypted.</p></div></li>
		</ol>
		<p class="ea-note">Everyday circles are free forever. Paid host extras — larger circles, cloud recordings — are metered by the second.</p>
	</div>
</section>`;
</script>

<svelte:head><title>Co-Intelligence Circle — Find coherence through human connection</title></svelte:head>

<!-- eslint-disable-next-line svelte/no-at-html-tags -->
<div bind:this={host}>{@html markup}</div>

<style>
	/* Pricing section — authored addition injected into the vendored landing.
	   Reuses the site's ea-* design tokens so it reads as production. */
	:global(.ea-pricing) {
		display: grid;
		gap: clamp(32px, 5vw, 56px);
		padding: clamp(64px, 8vw, 104px) 0;
		scroll-margin-top: 24px;
	}
	:global(.ea-pricing-head) {
		max-width: 640px;
		display: grid;
		gap: 12px;
	}
	:global(.ea-pricing-head h2) {
		font-size: clamp(28px, 4vw, 44px);
		line-height: 1.1;
		letter-spacing: -0.02em;
		margin: 0;
	}
	:global(.ea-pricing-head .ea-lead) {
		color: var(--ea-soft);
		font-size: 17px;
		line-height: 1.55;
		margin: 0;
	}
	:global(.ea-pricing-grid) {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 24px;
		align-items: start;
	}
	:global(.ea-price-card) {
		position: relative;
		display: grid;
		gap: 16px;
		background: #fff;
		border: 1px solid var(--ea-line);
		border-radius: 20px;
		padding: clamp(28px, 4vw, 40px);
	}
	:global(.ea-price-card h3) {
		font-size: 20px;
		margin: 0;
	}
	:global(.ea-price) {
		display: flex;
		align-items: baseline;
		gap: 10px;
		margin: 0;
	}
	:global(.ea-price b) {
		font-size: clamp(40px, 5vw, 52px);
		letter-spacing: -0.03em;
	}
	:global(.ea-price span) {
		color: var(--ea-mute);
		font-size: 14px;
	}
	:global(.ea-price-note) {
		color: var(--ea-soft);
		font-size: 14px;
		margin: 0;
	}
	:global(.ea-price-card ul) {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 10px;
		font-size: 15px;
	}
	:global(.ea-price-card li) {
		padding-left: 24px;
		position: relative;
	}
	:global(.ea-price-card li::before) {
		content: '✓';
		position: absolute;
		left: 0;
		color: var(--ea-blue);
		font-weight: 600;
	}
	:global(.ea-price-host) {
		border-color: var(--ea-ink);
		box-shadow: 0 12px 40px #0d0d0d14;
	}
	:global(.ea-price-badge) {
		position: absolute;
		top: -14px;
		left: 24px;
		background: var(--ea-ink);
		color: #fff;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.02em;
		padding: 5px 12px;
		border-radius: 999px;
		margin: 0;
	}
	:global(.ea-price-cta) {
		margin-top: 8px;
		text-decoration: none;
	}
	:global(.ea-price-ghost) {
		display: inline-flex;
		justify-content: center;
		align-items: center;
		min-height: 48px;
		padding: 0 24px;
		border: 1px solid var(--ea-line-strong);
		border-radius: 999px;
		color: var(--ea-ink);
		background: #fff;
		font: inherit;
		white-space: nowrap;
	}
	:global(.ea-price-ghost:hover) {
		border-color: var(--ea-ink);
	}
	:global(.ea-compare) {
		background: var(--ea-fill);
		border: 1px solid var(--ea-line);
		border-radius: 20px;
		padding: clamp(24px, 4vw, 36px);
		display: grid;
		gap: 16px;
	}
	:global(.ea-compare ul) {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 10px;
	}
	:global(.ea-compare li) {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 16px;
		align-items: baseline;
		font-size: 15px;
		padding: 10px 0;
		border-bottom: 1px solid var(--ea-line);
	}
	:global(.ea-compare li:last-child) {
		border-bottom: 0;
	}
	:global(.ea-compare b) {
		min-width: 150px;
	}
	:global(.ea-compare span) {
		color: var(--ea-soft);
	}
	:global(.ea-compare-us) {
		color: var(--ea-ink);
		font-weight: 600;
	}
	:global(.ea-compare-us span) {
		color: var(--ea-ink);
	}

	/* Open-availability CTA replacing the early-access request form */
	:global(.ea-open-pill) {
		font-weight: 600;
	}
	:global(.ea-open-cta) {
		display: inline-flex;
		justify-content: center;
		align-items: center;
		min-height: 52px;
		padding: 0 32px;
		border-radius: 999px;
		font-size: 17px;
		font-weight: 600;
		text-decoration: none;
	}
	:global(.ea-open-fine) {
		text-align: center;
	}
	:global(.ea-request .ea-form) {
		display: grid;
		justify-items: center;
		gap: 16px;
	}
</style>
