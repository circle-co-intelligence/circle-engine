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
