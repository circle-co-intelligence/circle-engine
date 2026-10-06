#!/usr/bin/env bash
# models-to-r2.sh — provision the free-egress model bucket on the
# regenleadership account and mirror every model byte the app fetches.
#
# Why: /ai/hf|ort|pack proxy through a billed Worker. Production must serve
# model bytes from genuinely-free infrastructure (R2 public bucket: free
# egress + free GETs at our scale), so unpaid users stay fully functional
# while "nothing served that isn't paid" holds for every Worker lane.
#
# Bucket layout (client: src/lib/ai/modelHost.ts):
#   pack/<key>                                  upstream tarballs/gguf
#   hf/<org>/<repo>/resolve/<rev>/<file>        transformers.js files
#   ort/<file>                                  onnxruntime-web wasm/mjs
#
# Requires: CLOUDFLARE_API_TOKEN scoped to the regenleadership account with
# R2 edit rights (the default wrangler OAuth profile here is terexmaps —
# never use it). CLOUDFLARE_ACCOUNT_ID=cf1f279501abeda01c1260a60cf95f5f.
#
#   CLOUDFLARE_API_TOKEN=… bash scripts/models-to-r2.sh
#
# After it runs, set on the gateway (workers/ai-gateway/wrangler.toml [vars]
# or `wrangler deploy --var`):
#   MODELS_BASE = "https://pub-<hash>.r2.dev"   # printed at the end
set -euo pipefail

BUCKET="${CIC_MODELS_BUCKET:-cic-models}"
: "${CLOUDFLARE_API_TOKEN:?set a regenleadership-scoped API token}"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-cf1f279501abeda01c1260a60cf95f5f}"
export CLOUDFLARE_API_TOKEN

WRANGLER="wrangler"           # the security gate wrapper passes non-deploy cmds through
TMP="$(mktemp -d /tmp/cic-models.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

echo "== bucket =="
$WRANGLER r2 bucket create "$BUCKET" 2>/dev/null || echo "exists"

# CORS — browsers fetch these under COEP require-corp; ACAO via bucket CORS
# satisfies it (fetch() is cors-mode by default). Scoped to the site origins.
cat > "$TMP/cors.json" <<'JSON'
{"rules": [{
	"allowed": {"origins": ["https://circle-engine-7ny.pages.dev", "https://circle-engine.pages.dev", "http://localhost:5173", "tauri://localhost"],
		"methods": ["GET", "HEAD"],
		"headers": ["*"]},
	"max_age_seconds": 86400
}]}
JSON
$WRANGLER r2 bucket cors set "$BUCKET" --file "$TMP/cors.json" --force

put() { # put <local-file> <r2-key>
	echo "  → $2 ($(du -h "$1" | cut -f1))"
	$WRANGLER r2 object put "$BUCKET/$2" --file "$1" -y --remote
}
pull() { # pull <url> <local-file>
	curl -sfL --retry 3 -o "$2" "$1"
}

echo "== packs (manifest.json upstream tarballs) =="
for key in vad asr-en asr-zh-en asr-zh-yue-en tts-en tts-multi llm; do
	url="$(python3 -c "import json; print(json.load(open('models/manifest.json'))['packs']['$key']['url'])")"
	f="$TMP/$key"
	pull "$url" "$f"
	put "$f" "pack/$key"
done
# aliases the gateway's PACK_URLS serves
for alias in asr tts; do
	src="$( [ "$alias" = asr ] && echo asr-en || echo tts-en )"
	pull "$(python3 -c "import json; print(json.load(open('models/manifest.json'))['packs']['$src']['url'])")" "$TMP/$alias"
	put "$TMP/$alias" "pack/$alias"
done

echo "== ort runtime =="
for f in ort-wasm-simd-threaded.asyncify.mjs ort-wasm-simd-threaded.asyncify.wasm; do
	pull "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/$f" "$TMP/$f"
	put "$TMP/$f" "ort/$f"
done

echo "== whisper (transformers.js repo mirror) =="
REPO="${VITE_CIC_WHISPER_MODEL:-onnx-community/whisper-base}"
REV=main
python3 - "$REPO" "$REV" > "$TMP/hf-files.txt" <<'PY'
import json, sys, urllib.request
repo, rev = sys.argv[1], sys.argv[2]
url = f"https://huggingface.co/api/models/{repo}/tree/{rev}?recursive=true"
tree = json.load(urllib.request.urlopen(url))
# everything transformers.js may ask for: configs, tokenizer, onnx weights
keep = [f["path"] for f in tree
        if f["type"] == "file" and (
            f["path"].endswith(".json") or f["path"].startswith("onnx/")
            or f["path"].startswith("tokenizer"))]
print("\n".join(keep))
PY
while IFS= read -r file; do
	[ -z "$file" ] && continue
	dst="$TMP/hf/$(dirname "$file")"
	mkdir -p "$dst"
	pull "https://huggingface.co/$REPO/resolve/$REV/$file" "$TMP/hf/$file"
	put "$TMP/hf/$file" "hf/$REPO/resolve/$REV/$file"
done < "$TMP/hf-files.txt"

echo "== public URL =="
$WRANGLER r2 bucket dev-url enable "$BUCKET" 2>/dev/null || true
URL="$($WRANGLER r2 bucket dev-url get "$BUCKET" 2>/dev/null | grep -o 'https://[^ ]*' | head -1)"
echo ""
echo "Done. Set MODELS_BASE=$URL on cic-ai-gateway and"
echo "VITE_CIC_MODELS_BASE=$URL in build:cf, then redeploy."
echo "(For a custom domain on a regenleadership zone, prefer that over r2.dev.)"
