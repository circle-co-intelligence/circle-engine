/**
 * Pages Function — /api/rec/{room}/{recId}/{segment}
 * Stores client-sealed recording ciphertext in R2. Objects are opaque
 * XChaCha20-Poly1305 blobs — no plaintext, no keys, ever reaches this edge.
 * Access control is cryptographic: possession of room+recId gets you
 * ciphertext that only the room secret opens.
 */
interface Env {
	REC_BUCKET: R2Bucket;
}

const PATH = /^api\/rec\/([\w-]+)\/([\w-]+)\/(\d+)$/;
const PREFIX_PATH = /^api\/rec\/([\w-]+)\/([\w-]+)$/;

export const onRequestPut: PagesFunction<Env> = async ({ request, env, params }) => {
	const m = PATH.exec((params.path as string[]).join('/'));
	if (!m) return new Response('bad path', { status: 400 });
	const body = await request.arrayBuffer();
	if (!body.byteLength || body.byteLength > 512 * 1024 * 1024)
		return new Response('bad size', { status: 413 });
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
