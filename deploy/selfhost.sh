#!/usr/bin/env bash
# selfhost.sh — one-command self-host: builds the frontend with this
# deployment's env baked in, renders coturn's config, brings the stack up.
set -euo pipefail
cd "$(dirname "$0")"

[[ -f .env ]] || { echo "copy env.example to .env and fill DOMAIN + TURN_SECRET"; exit 1; }
set -a; source .env; set +a
: "${DOMAIN:?}"; : "${TURN_SECRET:?}"

command -v docker >/dev/null || { echo "docker required"; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm required (corepack enable)"; exit 1; }

# build the static bundle pointed at THIS deployment
( cd .. && \
  VITE_CIC_LANES="${VITE_CIC_LANES:-mqtt}" \
  VITE_CIC_MQTT_BROKERS="${VITE_CIC_MQTT_BROKERS:-wss://${DOMAIN}/mqtt}" \
  VITE_CIC_TURN="${VITE_CIC_TURN:-}" \
  VITE_CIC_AI_ENDPOINT="${VITE_CIC_AI_ENDPOINT:-}" \
  VITE_CIC_DSP_ENDPOINT="${VITE_CIC_DSP_ENDPOINT:-}" \
  pnpm build )

# coturn has no env substitution — render the config
sed -e "s|\${TURN_SECRET}|${TURN_SECRET}|g" -e "s|\${REALM}|${DOMAIN}|g" \
	turnserver.conf > .turnserver.rendered.conf
mv .turnserver.rendered.conf turnserver.rendered.conf

docker compose up -d
echo "→ https://${DOMAIN} — caddy will provision TLS on first hit (needs 443 open)"
