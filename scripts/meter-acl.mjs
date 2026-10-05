#!/usr/bin/env node
/**
 * meter-acl.mjs — generate the MeterBus capability tokens + ACL.
 *
 * MeterBus (in cic-ai-gateway) is only reachable via the METER binding, but
 * a compromised sibling worker could otherwise debit/credit any pool. The
 * ACL maps sha256(token) → role so only holders of a per-worker token can
 * call it, and each role is limited to the ops it needs:
 *
 *   admin  → cic-pay         (all ops: credit/transfer/kvput/sponsor/…)
 *   spend  → cic-ai-gateway  (usage debits, grant-redemption credits, index)
 *   probe  → cic-sfu         (get/kvget/claim — balance reads for its gate)
 *   settle → cic-pay-hook    (webhook settlement: credits, bounded
 *                            clawback debits, settlement-record writes —
 *                            no sponsor, no transfer, no unsigned spend)
 *
 * Run once per environment, then paste the printed `wrangler secret put`
 * commands. METER_ACL goes on cic-ai-gateway; each METER_TOKEN on its own
 * worker. The ACL stores only hashes — leaking it reveals nothing.
 *
 *   node scripts/meter-acl.mjs
 */
import { createHash, randomBytes } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const roles = ['admin', 'spend', 'probe', 'settle'];
const worker = { admin: 'cic-pay', spend: 'cic-ai-gateway', probe: 'cic-sfu', settle: 'cic-pay-hook' };

const acl = {};
console.log('# MeterBus tokens — store each on its own worker, NEVER commit\n');
for (const role of roles) {
	const token = `mt_${randomBytes(24).toString('hex')}`;
	acl[sha256(token)] = role;
	console.log(`cd workers/${{ 'cic-pay': 'pay', 'cic-ai-gateway': 'ai-gateway', 'cic-sfu': 'sfu', 'cic-pay-hook': 'pay-hook' }[worker[role]]}`);
	console.log(`wrangler secret put METER_TOKEN   # ${role} role → ${token}\n`);
}
console.log('# On cic-ai-gateway only — the ACL itself (hashes, safe to set as var):');
console.log(`cd workers/ai-gateway`);
console.log(`wrangler secret put METER_ACL     # '${JSON.stringify(acl)}'\n`);
console.log('Or set it as a plain var in wrangler.toml — it contains only hashes.');
console.log(`METER_ACL = '${JSON.stringify(acl)}'`);
