import { chromium } from '@playwright/test';
const b = await chromium.launch();
const p = await b.newPage();
const hits = [];
p.on('request', r => { if (r.url().includes('/api/ux/') || r.url().includes('cic-analytics')) hits.push(r.method() + ' ' + r.url().slice(0, 100)); });
p.on('console', m => { if (m.type() === 'error') console.log('PAGE ERR:', m.text().slice(0, 160)); });
await p.goto('https://circle-engine-7ny.pages.dev/join');
await p.evaluate(() => localStorage.setItem('cic.uxConsent.v1', JSON.stringify({analytics:true,replay:false})));
await p.goto('https://circle-engine-7ny.pages.dev/join');
await p.waitForTimeout(4000);
console.log('hits:', hits);
// direct probe — does a fetch to the worker work from the page at all?
const r = await p.evaluate(async () => {
	try {
		const x = await fetch('https://cic-analytics.regenleadership.workers.dev/collect?sid=circle-engine&h=x&p=%2F&r=');
		return 'status ' + x.status;
	} catch (e) { return 'threw: ' + e.message; }
});
console.log('direct collect fetch:', r);
await b.close();
