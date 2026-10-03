<script lang="ts">
	/**
	 * CicApp — mounts the vendored production CIC application bundle.
	 * The real compiled frontend (vendored at static/cic) boots
	 * inside this element via its own SvelteKit start(); every backend
	 * touchpoint (room socket, caption socket, /api/*) is terminated by
	 * the local bridge installed before import.
	 */
	import { onMount, onDestroy } from 'svelte';
	import { base } from '$app/paths';
	import { installCicShims } from './install';

	let el: HTMLDivElement;
	let bootError = $state('');

	onMount(async () => {
		const roomKey = location.hash.slice(1) || undefined;
		try {
			installCicShims(roomKey);
			(globalThis as Record<string, unknown>).__sveltekit_qo28if = { base };
			// runtime URL imports — the vendored bundle lives in static/, outside vite's graph
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const load = (p: string) => import(/* @vite-ignore */ p) as Promise<any>;
			const [kit, app] = await Promise.all([
				load(`${base}/cic/entry/start.BOTuHuv5.js`),
				load(`${base}/cic/entry/app.D0k0gBOv.js`)
			]);
			await kit.start(app, el);
		} catch (e) {
			console.error('[cic] boot failed', e);
			bootError = e instanceof Error ? e.message : String(e);
		}
	});

	onDestroy(() => history.pushState({}, '', location.href));
</script>

{#if bootError}
	<p class="boot-error">Could not start the circle: {bootError}</p>
{/if}
<div bind:this={el} class="cic-host"></div>

<style>
	.cic-host {
		display: contents;
	}
	.boot-error {
		position: fixed;
		inset: auto 1rem 1rem 1rem;
		z-index: 999;
		background: #fff;
		border: 1px solid #d9534f;
		border-radius: 12px;
		padding: 0.75rem 1rem;
		color: #b23b37;
		font: 500 0.9rem/1.4 system-ui;
	}
</style>
