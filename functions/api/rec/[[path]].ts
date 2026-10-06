/**
 * Pages Function — /api/rec/{room}/{recId}/{segment}
 * Stores client-sealed recording ciphertext in R2. Objects are opaque
 * XChaCha20-Poly1305 blobs — no plaintext, no keys, ever reaches this edge.
 * Access control is cryptographic: possession of room+recId gets you
 * ciphertext that only the room secret opens.
 *
 * Billing: R2 storage is a paid lane — PUT requires a funded room pool (or
 * sponsor wallet) and debits the covering pool per MiB stored before the
 * object is written. Unfunded rooms keep the local sealed recording.
 */
interface Env {
	REC_BUCKET: R2Bucket;
	METER?: DurableObjectNamespace;
	METER_TOKEN?: string;
}

/** one pool-second per stored MiB — bounded by the 512MB segment cap */
const REC_COST_PER_MIB = 1;

async function meterOp(env: Env, inst: string, op: string, body: Record<string, unknown>) {
	const stub = env.METER!.get(env.METER!.idFromName(inst));
	const res = await stub.fetch(`https://meter/${op}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-meter-token': env.METER_TOKEN ?? '' },
		body: JSON.stringify({ inst, ...body })
	}).catch(() => null);
	return res?.ok ? ((await res.json()) as Record<string, unknown>) : null;
}

/** covering pool = room pool when funded, else the sponsor's wallet */
async function chargeRec(env: Env, room: string, bytes: number): Promise<boolean> {
	if (!env.METER) return true; // unbound = self-host, no metering
	const amount = Math.max(1, Math.ceil(bytes / (1024 * 1024)) * REC_COST_PER_MIB);
	const info = (await meterOp(env, room, 'get')) as
		| { balanceSeconds?: number; sponsor?: string | null }
		| null;
	if (!info) return false;
	let pool = room;
	if ((info.balanceSeconds ?? 0) <= 0 && info.sponsor) {
		const sp = (await meterOp(env, `acct:${info.sponsor}`, 'get')) as
			| { balanceSeconds?: number }
			| null;
		if ((sp?.balanceSeconds ?? 0) > 0) pool = `acct:${info.sponsor}`;
	}
	const res = await meterOp(env, pool, 'charge', { amount, room });
	return !!res;
}

const PATH = /^([\w-]+)\/([\w-]+)\/(\d+)$/;
const PREFIX_PATH = /^([\w-]+)\/([\w-]+)$/;

export const onRequestPut: PagesFunction<Env> = async ({ request, env, params }) => {
	const m = PATH.exec((params.path as string[]).join('/'));
	if (!m) return new Response('bad path', { status: 400 });
	// membership capability: only someone holding the room secret can mint it
	const ticket = request.headers.get('x-cic-room-ticket');
	if (env.METER && (!ticket || !/^[0-9a-f]{64}$/i.test(ticket)))
		return new Response('room ticket required', { status: 401 });
	const body = await request.arrayBuffer();
	if (!body.byteLength || body.byteLength > 512 * 1024 * 1024)
		return new Response('bad size', { status: 413 });
	// pay-before-serve: debit the covering pool for this segment's bytes
	// BEFORE writing — refused uploads never touch the bucket
	if (!(await chargeRec(env, m[1], body.byteLength)))
		return new Response('insufficient credits', { status: 402 });
	await env.REC_BUCKET.put(`rec/${m[1]}/${m[2]}/${m[3]}`, body, {
		httpMetadata: { contentType: 'application/octet-stream' }
	});
	return new Response(null, { status: 201 });
};

export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
	const m = PATH.exec((params.path as string[]).join('/'));
	if (!m) return new Response('bad path', { status: 400 });
	const obj = await env.REC_BUCKET.get(`rec/${m[1]}/${m[2]}/${m[3]}`);
	if (!obj) return new Response('not found', { status: 404 });
	return new Response(obj.body, {
		headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' }
	});
};

/**
 * DELETE /api/rec/{room}/{recId} — drop a recording prefix (all segments).
 * Used when a participant withdraws consent mid-record: their sealed ISO
 * objects are removed. The objects were ciphertext-only either way.
 */
export const onRequestDelete: PagesFunction<Env> = async ({ env, params }) => {
	const m = PREFIX_PATH.exec((params.path as string[]).join('/'));
	if (!m) return new Response('bad path', { status: 400 });
	const prefix = `rec/${m[1]}/${m[2]}/`;
	let cursor: string | undefined;
	do {
		const page = await env.REC_BUCKET.list({ prefix, cursor, limit: 500 });
		await Promise.all(page.objects.map((o) => env.REC_BUCKET.delete(o.key)));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return new Response(null, { status: 204 });
};
