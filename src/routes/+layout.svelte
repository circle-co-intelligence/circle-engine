<script lang="ts">
	import '../app.css';
	// Safari/Firefox WebRTC normalization — dep already in tree, side-effect only
	import 'webrtc-adapter';
	import { initErrorMonitoring } from '$lib/obs/errors';
	import { initDeepLinks } from '$lib/native';
	import { onMount } from 'svelte';
	let { children } = $props();
	onMount(() => {
		initDeepLinks();
		void initErrorMonitoring();
		// consent-gated UX telemetry — no-ops silently until the user opts in
		void import('$lib/obs/ux').then((m) => m.initUx());
	});
</script>

{@render children()}
