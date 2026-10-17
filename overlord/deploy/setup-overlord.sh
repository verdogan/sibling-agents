#!/usr/bin/env bash
#
# Install the single overlord host. Run from overlord/ as root and provide
# the registry emitted by ling/deploy/setup-fleet.sh.
set -euo pipefail

REGISTRY=${1:-}
if [[ -z "$REGISTRY" || ! -f "$REGISTRY" ]]; then
  echo "Usage: sudo bash deploy/setup-overlord.sh <ling-workers.json>" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "Run this as root." >&2
  exit 1
fi

APP_USER=lingoverlord
APP_DIR=/opt/ling-overlord
STATE_DIR=/var/lib/ling-overlord
ENV_FILE=/etc/ling-overlord.env
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQUIRED_NODE=24.0.0

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl
node_version() { node -e 'process.stdout.write(process.versions.node)' 2>/dev/null; }
if ! command -v node >/dev/null 2>&1 || ! dpkg --compare-versions "$(node_version)" ge "$REQUIRED_NODE"; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

mkdir -p "$APP_DIR" "$STATE_DIR/campaigns"
tar -C "$SOURCE_DIR" --exclude=node_modules --exclude=dist --exclude=.env -cf - . |
  tar -C "$APP_DIR" -xf -
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$STATE_DIR"
runuser -u "$APP_USER" -- npm --prefix "$APP_DIR" ci
runuser -u "$APP_USER" -- npm --prefix "$APP_DIR" run build

workers_json="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))))' "$REGISTRY")"
if [[ ! -f "$ENV_FILE" ]]; then
  cat >"$ENV_FILE" <<EOF
# Root-owned overlord configuration. Worker tokens and webhook credentials are secrets.
LING_WORKERS_JSON='${workers_json}'
LING_AUTO_START=false
LING_REQUEST_TIMEOUT_MS=30000
LING_PROVISIONER=
LING_LOCAL_WORKER_ROOT=
LING_LOCAL_WORKER_TTL_MS=3600000

# Empty means every supported Ling tool. Set a comma-separated subset only
# when this deployment has a concrete reason to narrow agent capabilities.
FLEET_ALLOWED_TOOLS=
FLEET_ALLOWED_PROVIDERS=
FLEET_ALLOWED_MODELS=
FLEET_ALLOWED_SKILLS=
FLEET_ALLOW_INLINE_SKILLS=false
FLEET_MAX_TASKS=8
FLEET_MAX_CONCURRENT=2
FLEET_MAX_TOTAL_COST_USD=10
FLEET_LEDGER_PATH=${STATE_DIR}/fleet-ledger.db
FLEET_LEDGER_RETENTION_DAYS=30
FLEET_LEDGER_INFLIGHT_STALE_MS=7200000

# OpenAI-compatible decision model, remote by default. Campaigns opt in separately.
OVERLORD_BRAIN_BASE_URL=
OVERLORD_BRAIN_MODEL=
OVERLORD_BRAIN_API_KEY=
# Set true only when serving the model inside the cell.
OVERLORD_BRAIN_REQUIRE_CELL_LOCAL=false
OVERLORD_BRAIN_TIMEOUT_MS=60000
OVERLORD_BRAIN_MAX_ATTEMPTS=3
OVERLORD_BRAIN_MAX_OUTPUT_TOKENS=2048

CAMPAIGN_ROOTS=${STATE_DIR}/campaigns
CAMPAIGN_ARTIFACT_RETENTION_DAYS=90
CAMPAIGN_LOCK_STALE_MS=86400000
CAMPAIGN_PROGRESS_WEBHOOK_URL=
CAMPAIGN_PROGRESS_WEBHOOK_TOKEN=
CAMPAIGN_PROGRESS_WEBHOOK_MAX_ATTEMPTS=3
CAMPAIGN_PROGRESS_WEBHOOK_RETRY_MS=500
CAMPAIGN_STALL_MS=1200000
OVERLORD_PROFILE_LIBRARY=
EOF
else
  WORKERS_JSON="$workers_json" node - "$ENV_FILE" <<'NODE'
const fs = require("node:fs");
const filename = process.argv[2];
const replacement = `LING_WORKERS_JSON='${process.env.WORKERS_JSON}'`;
const lines = fs.readFileSync(filename, "utf8").split(/\r?\n/);
const index = lines.findIndex((line) => line.startsWith("LING_WORKERS_JSON="));
if (index >= 0) lines[index] = replacement;
else lines.push(replacement);
fs.writeFileSync(filename, `${lines.filter((line, i) => line !== "" || i < lines.length - 1).join("\n")}\n`);
NODE
fi
chmod 600 "$ENV_FILE"
chown root:root "$ENV_FILE"

install -m 0644 "$APP_DIR/deploy/ling-campaign@.service" /etc/systemd/system/
install -m 0644 "$APP_DIR/deploy/campaign-retention.service" /etc/systemd/system/
install -m 0644 "$APP_DIR/deploy/campaign-retention.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now campaign-retention.timer

cat <<EOF

Overlord installed. Next:
  1. Set CAMPAIGN_PROGRESS_WEBHOOK_URL and TOKEN in ${ENV_FILE}.
  2. Initialize a campaign under ${STATE_DIR}/campaigns/<name>.
  3. Start it with: systemctl enable --now ling-campaign@<name>
     (enable, not just start, so the campaign resumes after a reboot)
  4. Follow it with: journalctl -u ling-campaign@<name> -f
  5. When the campaign is finished: systemctl disable ling-campaign@<name>
EOF
