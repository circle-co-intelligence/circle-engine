import { loadPolicy } from '@open-policy-agent/opa-wasm';
import type { Op, RoomState } from '../wire/messages';

/**
 * OPA-Wasm policy engine — evaluates cic.rego (compiled to static/policy/cic.wasm
 * by `opa build -t wasm`, see package.json `policy:build`).
 * Every client evaluates every op against these rules before applying it.
 */

import { base } from '$app/paths';

type Policy = { evaluate(input: unknown, entrypoint?: string): { result: unknown }[] };

let policy: Policy | null = null;
let policyPromise: Promise<void> | null = null;

export function initPolicy(): Promise<void> {
	policyPromise ??= (async () => {
		try {
			const wasm = await fetch(`${base}/policy/cic.wasm`).then((r) => r.arrayBuffer());
			policy = await loadPolicy(wasm);
			console.debug('[engine] policy loaded');
		} catch (e) {
			console.error('[engine] policy load failed', e);
		}
	})();
	return policyPromise;
}

export function policyLoaded(): boolean {
	return !!policy;
}

function evalEntry<T>(entrypoint: string, input: unknown): T | undefined {
	if (!policy) return undefined;
	// opa-wasm evaluate(input, entrypoint) → [{result: value}] — the value is the
	// rule's document itself (deny set / allow boolean), not keyed by entrypoint
	const out = policy.evaluate(input, entrypoint);
	return out[0]?.result as T | undefined;
}

export interface Actor {
	id: string;
	canManageRoom: boolean;
}

/** returns list of deny reasons; empty = allowed */
export function denyReasons(op: Op, actor: Actor, state: RoomState): string[] {
	return evalEntry<string[]>('cic/deny', { op, actor, state }) ?? ['policy not loaded'];
}

export function allowed(op: Op, actor: Actor, state: RoomState): boolean {
	return evalEntry<boolean>('cic/allow', { op, actor, state }) === true;
}
