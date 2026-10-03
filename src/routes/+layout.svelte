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
	});
</script>

{@render children()}
