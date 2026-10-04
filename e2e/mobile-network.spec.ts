import { test, expect } from '@playwright/test';

/**
 * Mobile + degraded-network coverage.
 *
 * Emulates a phone-sized viewport (touch, mobile UA) and applies CDP
 * network conditions — ~250ms RTT, ~1Mbps shaping — while two peers
 * join the same room. CDP emulation shapes HTTP/signaling traffic; it
 * cannot drop WebRTC UDP (that needs netem/TURN relaying), so media
 * assertions verify the transport survives slow-signaling joins rather
 * than true packet loss.
 */
test.describe('mobile + degraded network', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'CDP network emulation is chromium-only');

	test('mobile viewport joins and renders the circle UI', async ({ browser }) => {
		const ctx = await browser.newContext({
			viewport: { width: 390, height: 844 },
			isMobile: true,
			hasTouch: true,
			userAgent:
				'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36'
		});
		const page = await ctx.newPage();
		await page.goto('/room/777001');
		await expect(page.getByRole('heading', { name: 'Join the circle' })).toBeVisible({
			timeout: 15_000
		});
		await page.getByPlaceholder('Your name').fill('Mo');
		await page.getByRole('button', { name: 'Join circle' }).click();
		await expect(page.getByRole('group', { name: 'Circle room' })).toBeVisible({
			timeout: 20_000
		});
		await ctx.close();
	});

	test('two peers join and see each other under 250ms/1Mbps shaping', async ({
		browser
	}) => {
		const ctx1 = await browser.newContext();
		const ctx2 = await browser.newContext();
		const p1 = await ctx1.newPage();
		const p2 = await ctx2.newPage();
		const code = String(Math.floor(100000 + Math.random() * 900000));

		// shape both pages' HTTP+WebSocket traffic before navigation
		for (const p of [p1, p2]) {
			const cdp = await p.context().newCDPSession(p);
			await cdp.send('Network.enable');
			await cdp.send('Network.emulateNetworkConditions', {
				offline: false,
				latency: 250,
				downloadThroughput: 1_000_000 / 8,
				uploadThroughput: 1_000_000 / 8
			});
		}

		for (const [p, n] of [
			[p1, 'Ada'],
			[p2, 'Grace']
		] as const) {
			await p.goto(`/room/${code}`);
			await p.getByPlaceholder('Your name').fill(n);
			await p.getByRole('button', { name: 'Join circle' }).click();
		}
		// relay joins take longer under shaping — generous bound
		await expect(p2.locator('article').filter({ hasText: 'Ada' })).toHaveCount(1, {
			timeout: 75_000
		});
		await ctx1.close();
		await ctx2.close();
	});
});
