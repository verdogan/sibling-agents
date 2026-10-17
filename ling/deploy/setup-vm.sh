#!/usr/bin/env bash
#
# Provisions a Debian or Ubuntu VM to run the agent as an unprivileged service.
# Run as root from a checkout of this repository:
#
#   sudo bash deploy/setup-vm.sh
#
set -euo pipefail

APP_USER=piagent
APP_DIR=/opt/autonomous-pi-agent
ENV_FILE=/etc/autonomous-pi-agent.env
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_DIR/deploy/lib.sh"
WORKER_ID=${WORKER_ID:-$(hostname -s)}
BIND_ADDRESS=${BIND_ADDRESS:-127.0.0.1}
MAX_CONCURRENCY=${MAX_CONCURRENCY:-2}

if [[ $EUID -ne 0 ]]; then
  echo "Run this as root." >&2
  exit 1
fi

echo "==> Installing base packages"
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl git podman uidmap slirp4netns fuse-overlayfs

# agent-browser requires Node 24; that also satisfies pi's >=22.19.0 floor.
# Compare with dpkg, not with [[ < ]]: string comparison puts 22.9.0 and even
# 8.20.0 above 22.19.0 and would skip an installation the app needs.
REQUIRED_NODE=24.0.0
node_version() { node -e 'process.stdout.write(process.versions.node)' 2>/dev/null; }

if ! command -v node >/dev/null 2>&1 || ! dpkg --compare-versions "$(node_version)" ge "$REQUIRED_NODE"; then
  echo "==> Installing Node.js 24.x (need >= ${REQUIRED_NODE})"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

if ! dpkg --compare-versions "$(node_version)" ge "$REQUIRED_NODE"; then
  echo "Node $(node_version) is older than the required ${REQUIRED_NODE} even after installing. Fix the node source and re-run." >&2
  exit 1
fi
echo "    node $(node --version)"

echo "==> Creating service user ${APP_USER}"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi
grep -q "^${APP_USER}:" /etc/subuid || echo "${APP_USER}:100000:65536" >>/etc/subuid
grep -q "^${APP_USER}:" /etc/subgid || echo "${APP_USER}:100000:65536" >>/etc/subgid

echo "==> Copying application to ${APP_DIR}"
mkdir -p "$APP_DIR"
if [[ "$REPO_DIR" != "$APP_DIR" ]]; then
  # Never copy local secrets or scratch state onto the server.
  tar -C "$REPO_DIR" \
    --exclude=node_modules --exclude=.git --exclude=workspaces \
    --exclude=auth --exclude=.env --exclude=dist --exclude=data \
    --exclude=runtime-home --exclude=browsers \
    -cf - . | tar -C "$APP_DIR" -xf -
fi
mkdir -p "$APP_DIR/workspaces" "$APP_DIR/auth" "$APP_DIR/browsers" \
  "$APP_DIR/data" "$APP_DIR/recipes" "$APP_DIR/runtime-home"
chmod 700 "$APP_DIR/auth"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> Installing dependencies"
runuser -u "$APP_USER" -- env HOME="/home/$APP_USER" npm --prefix "$APP_DIR" ci

echo "==> Installing Chromium and its system libraries"
# The apt side needs root; the browser download belongs to the service user so
# it lands in PLAYWRIGHT_BROWSERS_PATH with the right ownership.
(cd "$APP_DIR" && npx --yes playwright install-deps chromium)
runuser -u "$APP_USER" -- env HOME="/home/$APP_USER" PLAYWRIGHT_BROWSERS_PATH="$APP_DIR/browsers" \
  npx --yes --prefix "$APP_DIR" playwright install chromium

echo "==> Installing agent-browser Chrome"
# Run this as root so --with-deps can use apt. HOME points inside the app
# because ProtectHome hides /home from the service; ownership is restored
# immediately afterwards.
(cd "$APP_DIR" && HOME="$APP_DIR/runtime-home" npx agent-browser install --with-deps)
chown -R "$APP_USER:$APP_USER" "$APP_DIR/runtime-home"
runuser -u "$APP_USER" -- env HOME="$APP_DIR/runtime-home" \
  npm --prefix "$APP_DIR" run browser:doctor

echo "==> Building"
runuser -u "$APP_USER" -- env HOME="/home/$APP_USER" npm --prefix "$APP_DIR" run build

echo "==> Verifying the per-task container sandbox"
RUNTIME_DIR="/run/${APP_USER}-containers"
mkdir -p "$RUNTIME_DIR"
chown "$APP_USER:$APP_USER" "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR"
runuser -u "$APP_USER" -- env \
  HOME="$APP_DIR/runtime-home" \
  XDG_RUNTIME_DIR="$RUNTIME_DIR" \
  podman pull node:24-bookworm-slim
runuser -u "$APP_USER" -- env \
  HOME="$APP_DIR/runtime-home" \
  XDG_RUNTIME_DIR="$RUNTIME_DIR" \
  SANDBOX_MODE=docker \
  CONTAINER_RUNTIME=podman \
  SANDBOX_IMAGE=node:24-bookworm-slim \
  npm --prefix "$APP_DIR" run sandbox-check

if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> Writing ${ENV_FILE}"
  TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat >"$ENV_FILE" <<EOF
# Autonomous Pi Agent service configuration. Owned by root, mode 0600.
OPENAI_API_KEY=
AGENT_PROVIDER=openai
AGENT_MODEL=gpt-5.6-terra
AGENT_THINKING=medium

AGENT_TOKEN=${TOKEN}
AGENT_TOKENS_JSON='{"production-overlord":"${TOKEN}"}'
WORKER_ID=${WORKER_ID}
BIND_ADDRESS=${BIND_ADDRESS}
PORT=8787

MAX_TURNS=40
MAX_WALL_CLOCK_MS=900000
MAX_COST_USD=2.00
MAX_CONCURRENCY=${MAX_CONCURRENCY}
ALLOW_INLINE_SKILLS=false
MAX_SKILLS_PER_TASK=16
MAX_INLINE_SKILLS_PER_TASK=8
MAX_INLINE_SKILL_BYTES=16384
MAX_INLINE_SKILLS_TOTAL_BYTES=65536
TASK_RATE_LIMIT_PER_MINUTE=30
TASK_RATE_LIMIT_BURST=30
SHUTDOWN_GRACE_MS=960000
WORKSPACE_RETENTION_DAYS=30

BROWSER_HEADLESS=true
BROWSER_TRACE=false

AGENT_BROWSER_MAX_OUTPUT=12000
AGENT_BROWSER_SESSION_PREFIX=ling
AGENT_BROWSER_IDLE_TIMEOUT_MS=300000
AGENT_BROWSER_REPAIR_COOLDOWN_MS=86400000

# Refuse loopback, private-range and cloud metadata targets from http_request.
BLOCK_PRIVATE_NETWORK=true

SANDBOX_MODE=docker
CONTAINER_RUNTIME=podman
SANDBOX_IMAGE=node:24-bookworm-slim
# Shell tasks do not get raw network egress. Browser and http_request remain
# subject to the host firewall and application-level private-network block.
SANDBOX_NETWORK=none
EOF
  chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
  echo "    generated AGENT_TOKEN: ${TOKEN}"
  echo "    put your provider key in ${ENV_FILE} before starting"
fi

ensure_env "$ENV_FILE" WORKER_ID "$WORKER_ID"
ensure_env "$ENV_FILE" BIND_ADDRESS "$BIND_ADDRESS"
ensure_env "$ENV_FILE" MAX_CONCURRENCY "$MAX_CONCURRENCY"
ensure_env "$ENV_FILE" ALLOW_INLINE_SKILLS false
ensure_env "$ENV_FILE" MAX_SKILLS_PER_TASK 16
ensure_env "$ENV_FILE" MAX_INLINE_SKILLS_PER_TASK 8
ensure_env "$ENV_FILE" MAX_INLINE_SKILL_BYTES 16384
ensure_env "$ENV_FILE" MAX_INLINE_SKILLS_TOTAL_BYTES 65536
ensure_env "$ENV_FILE" SANDBOX_MODE docker
ensure_env "$ENV_FILE" CONTAINER_RUNTIME podman
ensure_env "$ENV_FILE" SANDBOX_NETWORK none
ensure_env "$ENV_FILE" WORKSPACE_RETENTION_DAYS 30
CURRENT_TOKEN="$(awk -F= '$1=="AGENT_TOKEN"{print $2}' "$ENV_FILE")"
ensure_env "$ENV_FILE" AGENT_TOKENS_JSON "'{\"production-overlord\":\"${CURRENT_TOKEN}\"}'"
chmod 600 "$ENV_FILE"

echo "==> Installing systemd unit"
install -m 0644 "$APP_DIR/deploy/podman.service" /etc/systemd/system/ling-podman.service
install -m 0644 "$APP_DIR/deploy/agent.service" /etc/systemd/system/autonomous-pi-agent.service
install -m 0644 "$APP_DIR/deploy/monitor-replay.service" /etc/systemd/system/ling-monitor-replay.service
install -m 0644 "$APP_DIR/deploy/monitor-replay.timer" /etc/systemd/system/ling-monitor-replay.timer
systemctl daemon-reload
systemctl enable ling-podman.service
systemctl enable autonomous-pi-agent.service
systemctl enable ling-monitor-replay.timer

cat <<'EOF'

Done. Remaining steps, in order:

  1. Put your provider API key in /etc/autonomous-pi-agent.env
  2. sudo systemctl start autonomous-pi-agent
  3. sudo systemctl start ling-monitor-replay.timer
  4. journalctl -u autonomous-pi-agent -f
  5. Reach it from your machine over an SSH tunnel, never by opening the port:
       ssh -N -L 8787:127.0.0.1:8787 you@this-vm
  6. Optionally restrict outbound traffic: sudo bash deploy/egress-allowlist.sh

EOF
