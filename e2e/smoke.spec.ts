import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('entry page renders and creates a circle', async ({ page }) => {
	await page.goto('/');
	// vendored marketing landing — verbatim from the scraped www site
	await expect(page.getByRole('heading', { name: /find coherence/i })).toBeVisible();
	await page.getByRole('link', { name: 'Log in' }).first().click();
	await expect(page).toHaveURL(/\/join/);
	await page.getByPlaceholder('Ada').fill('Ada');
	await page.getByRole('button', { name: 'Join circle' }).click();
	await expect(page).toHaveURL(/\/room\/\d{6}/);
	// prod's own prejoin gate, then the room
	await expect(page.getByRole('heading', { name: 'Join the circle' })).toBeVisible({ timeout: 15_000 });
	await page.getByPlaceholder('Your name').fill('Ada');
	await page.getByRole('button', { name: 'Join circle' }).click();
	await expect(page.getByRole('group', { name: 'Circle room' })).toBeVisible({ timeout: 20_000 });
});

test('prejoin gate shows on a bare room link', async ({ page }) => {
	await page.goto('/room/123456');
	await expect(page.getByRole('heading', { name: 'Join the circle' })).toBeVisible();
	await expect(page.getByPlaceholder('Your name')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Join circle' })).toBeVisible();
});

test('join muted: mic starts off and unmute is explicit', async ({ page }) => {
	await page.goto('/room/123456');
	await page.getByPlaceholder('Your name').fill('Ada');
	await page.getByRole('button', { name: 'Join circle' }).click();
	await expect(page.locator('[data-ux-id="microphone"][aria-label*="Unmute"]')).toBeVisible({
		timeout: 20_000
	});
});

test('entry page passes axe accessibility scan', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: /find coherence/i })).toBeVisible();
	const results = await new AxeBuilder({ page }).analyze();
	// vendored marketing markup carries its own known violations (color-contrast
	// 4.15:1 on .ea-eyebrow, link-in-text-block) — we don't patch the scraped
	// page, so gate only on critical regressions
	const critical = results.violations.filter((v) => v.impact === 'critical');
	expect(critical).toEqual([]);
});

test('two browsers share a room code (P2P join)', async ({ browser }) => {
	const ctx1 = await browser.newContext();
	const ctx2 = await browser.newContext();
	const p1 = await ctx1.newPage();
	const p2 = await ctx2.newPage();
	const code = String(Math.floor(100000 + Math.random() * 900000));

	for (const [p, n] of [[p1, 'Ada'], [p2, 'Grace']] as const) {
		await p.goto(`/room/${code}`);
		await p.getByPlaceholder('Your name').fill(n);
		await p.getByRole('button', { name: 'Join circle' }).click();
	}
	// peer join is async over relays — remote seat shows a "Mute <name>" control
	await expect(p2.locator('article').filter({ hasText: 'Ada' })).toHaveCount(1, {
		timeout: 60_000
	});
	await ctx1.close();
	await ctx2.close();
});
