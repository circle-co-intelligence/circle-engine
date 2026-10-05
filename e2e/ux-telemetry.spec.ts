import { test, expect } from '@playwright/test';

/**
 * UX telemetry consent gating — the whole pipeline must stay silent until
 * the user opts in, and must stay silent forever under GPC/DNT. The Pages
 * Function doesn't exist in `vite preview`, so route stubs stand in for it;
 * what matters is what the CLIENT sends and when.
 */
const CONSENT_KEY = 'cic.uxConsent.v1';
const VISIT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const mint = {
	token: 'v1.fake.test',
	visitId: VISIT,
	exp: Math.floor(Date.now() / 1000) + 3600
};

function stubUx(page: import('@playwright/test').Page) {
	const hits: { path: string; body: unknown }[] = [];
	for (const path of ['session', 'events', 'revoke', 'replay/chunks', 'replay/close']) {
		void page.route(`**/api/ux/${path}`, async (route) => {
			const req = route.request();
			let body: unknown = null;
			try {
				body = req.postDataJSON();
			} catch {}
			hits.push({ path, body });
			if (path === 'session') return route.fulfill({ json: mint });
			if (path === 'events') return route.fulfill({ json: { ok: true, accepted: 1 } });
			return route.fulfill({ status: 204 });
		});
	}
	return hits;
}

const seedConsent = (page: import('@playwright/test').Page, c: { analytics: boolean; replay: boolean } | null) =>
	page.addInitScript(
		([key, val]) => {
			if (val === null) localStorage.removeItem(key);
			else localStorage.setItem(key, JSON.stringify(val));
		},
		[CONSENT_KEY, c] as const
	);

test.describe('ux telemetry consent gate', () => {
	test('no consent → zero telemetry traffic', async ({ page }) => {
		const hits = stubUx(page);
		await seedConsent(page, null);
		await page.goto('/join');
		await page.waitForTimeout(3000);
		expect(hits).toHaveLength(0);
	});

	test('analytics consent → session mint + events, no replay', async ({ page }) => {
		const hits = stubUx(page);
		await seedConsent(page, { analytics: true, replay: false });
		await page.goto('/join');
		await expect.poll(() => hits.some((h) => h.path === 'session'), { timeout: 10_000 }).toBe(true);
		// trigger a flush through the test seam
		await page.evaluate(() => (window as unknown as { __ux?: { flush?: () => Promise<void> } }).__ux?.flush?.());
		await expect
			.poll(() => hits.filter((h) => h.path === 'events').length, { timeout: 5_000 })
			.toBeGreaterThan(0);
		// replay routes must stay silent with replay:false
		expect(hits.some((h) => h.path.startsWith('replay/'))).toBe(false);
		// event payload carries no identity — token only, enum schema
		const ev = hits.find((h) => h.path === 'events')?.body as { token: string; events: { event: string; page: string }[] };
		expect(ev.token).toBe(mint.token);
		expect(ev.events[0].event).toBe('visit_start');
		expect(ev.events.every((e) => ['setup', 'join', 'prejoin', 'room'].includes(e.page))).toBe(true);
	});

	test('GPC/DNT forces collection off even with consent stored', async ({ page }) => {
		const hits = stubUx(page);
		await seedConsent(page, { analytics: true, replay: true });
		await page.addInitScript(() => {
			Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
		});
		await page.goto('/join');
		await page.waitForTimeout(3000);
		expect(hits).toHaveLength(0);
	});

	test('replay consent → masked recorder uploads chunks in room', async ({ page }) => {
		const hits = stubUx(page);
		await seedConsent(page, { analytics: true, replay: true });
		// preview doesn't run patch-pages — stub the discovery file so the
		// vendored recorder chunk loads from the real bundle
		await page.route('**/cic/replay-chunk.txt', (route) =>
			route.fulfill({ body: 'D_hX0jLj.js', contentType: 'text/plain' })
		);
		const code = String(Math.floor(100000 + Math.random() * 900000));
		await page.goto(`/room/${code}`);
		await page.getByPlaceholder('Your name').fill('Rae');
		await page.getByRole('button', { name: 'Join circle' }).click();
		await expect(page.getByRole('group', { name: 'Circle room' })).toBeVisible({ timeout: 20_000 });
		// recorder uploads its first chunk on the 3s interval
		await expect
			.poll(() => hits.some((h) => h.path === 'replay/chunks'), { timeout: 15_000 })
			.toBe(true);
		const chunk = hits.find((h) => h.path === 'replay/chunks')?.body as {
			token: string;
			visitId: string;
			chunkIndex: number;
			events: { type: number; data?: { href?: string } }[];
		};
		expect(chunk.token).toBe(mint.token);
		expect(chunk.visitId).toBe(VISIT);
		// rrweb envelope shape — and the synthetic href proves no real URL leaks
		expect(chunk.events.every((e) => typeof e.type === 'number')).toBe(true);
		const meta = chunk.events.find((e) => e.type === 4);
		expect(meta?.data?.href).toMatch(/^https:\/\/replay\.invalid\//);
	});
});
