/**
 * hlsPlay.ts — webinar fanout playback. A witness past the mesh scale
 * ceiling plays the room's Cloudflare Stream HLS manifest instead of
 * pulling per-peer tracks. hls.js loads lazily — the common path
 * (Safari's native HLS, or no webinar at all) never pays the bundle cost.
 */
export async function attachHls(video: HTMLVideoElement, url: string): Promise<() => void> {
	// native HLS (Safari, iOS) needs no library
	if (video.canPlayType('application/vnd.apple.mpegurl')) {
		video.src = url;
		await video.play().catch(() => {});
		return () => video.removeAttribute('src');
	}
	const { default: Hls } = await import('hls.js');
	if (!Hls.isSupported()) return () => {};
	const hls = new Hls({ liveSyncDurationCount: 3, enableWorker: true });
	hls.loadSource(url);
	hls.attachMedia(video);
	await video.play().catch(() => {});
	return () => hls.destroy();
}
