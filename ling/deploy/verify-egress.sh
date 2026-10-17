#!/usr/bin/env bash
set -euo pipefail

APP_USER=${APP_USER:-piagent}
APP_DIR=${APP_DIR:-/opt/autonomous-pi-agent}
CONTAINER_HOST=${CONTAINER_HOST:-unix:///run/piagent-podman/podman.sock}

if [[ $EUID -ne 0 ]]; then
  echo "Run this as root." >&2
  exit 1
fi

allowed_code="$(runuser -u "$APP_USER" -- curl -sS -o /dev/null -w '%{http_code}' \
  --max-time 10 https://api.openai.com/v1/models)"
if [[ "$allowed_code" == "000" ]]; then
  echo "FAIL: allowed provider endpoint is unreachable" >&2
  exit 1
fi
echo "PASS: provider endpoint reachable (HTTP ${allowed_code})"

if runuser -u "$APP_USER" -- curl -fsS --max-time 5 https://example.com >/dev/null 2>&1; then
  echo "FAIL: non-allowlisted public egress succeeded" >&2
  exit 1
fi
echo "PASS: non-allowlisted public egress blocked"

if runuser -u "$APP_USER" -- curl -fsS --max-time 3 http://169.254.169.254 >/dev/null 2>&1; then
  echo "FAIL: cloud metadata egress succeeded" >&2
  exit 1
fi
echo "PASS: cloud metadata egress blocked"

# Loopback is scoped by uid. A listener root owns stands in for another user's
# local service, which the agent must not reach; one the agent owns, such as
# agent-browser's Chrome, it must. Each listener exits on its own after 10 s.
LOOPBACK_PROBE_PORT=${LOOPBACK_PROBE_PORT:-18799}
start_listener() {
  runuser -u "$1" -- node -e '
    require("node:http").createServer((req, res) => res.end("ok")).listen(Number(process.argv[1]), "127.0.0.1");
    setTimeout(() => process.exit(0), 10000);
  ' "$2" &
  for _ in $(seq 1 40); do
    curl -fsS --max-time 1 "http://127.0.0.1:$2" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  echo "FAIL: the loopback probe listener for $1 did not start" >&2
  exit 1
}

start_listener root "$LOOPBACK_PROBE_PORT"
if runuser -u "$APP_USER" -- curl -fsS --max-time 3 "http://127.0.0.1:${LOOPBACK_PROBE_PORT}" >/dev/null 2>&1; then
  echo "FAIL: the agent reached a loopback listener another user owns" >&2
  exit 1
fi
echo "PASS: another user's loopback listener blocked"

start_listener "$APP_USER" "$((LOOPBACK_PROBE_PORT + 1))"
if ! runuser -u "$APP_USER" -- curl -fsS --max-time 3 "http://127.0.0.1:$((LOOPBACK_PROBE_PORT + 1))" >/dev/null 2>&1; then
  echo "FAIL: the agent could not reach its own loopback listener" >&2
  exit 1
fi
echo "PASS: the agent's own loopback listener reachable"

# Some answers on the agent's own connections come from a socket no process
# owns: this listener of the agent's writes a large response and closes the
# connection at once, so the kernel sends the rest from an orphaned socket,
# and curl reads slowly enough that there is a rest. All of it must arrive.
LARGE_PORT=$((LOOPBACK_PROBE_PORT + 3))
LARGE_BYTES=$((16 * 1024 * 1024))
runuser -u "$APP_USER" -- node -e '
  const size = Number(process.argv[2]);
  require("node:net").createServer((socket) => {
    let request = "";
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      if (request.includes("\r\n\r\n")) return;
      request += chunk;
      if (!request.includes("\r\n\r\n")) return;
      socket.write(`HTTP/1.0 200 OK\r\nContent-Length: ${size}\r\n\r\n`);
      socket.end(Buffer.alloc(size, 97), () => socket.destroy());
    });
  }).listen(Number(process.argv[1]), "127.0.0.1");
  setTimeout(() => process.exit(0), 30000);
' "$LARGE_PORT" "$LARGE_BYTES" &
for _ in $(seq 1 40); do
  curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:${LARGE_PORT}" 2>/dev/null && break
  sleep 0.25
done
received="$(runuser -u "$APP_USER" -- curl -sS --max-time 15 --limit-rate 4M -o /dev/null \
  -w '%{size_download}' "http://127.0.0.1:${LARGE_PORT}" 2>/dev/null || true)"
if [[ "$received" != "$LARGE_BYTES" ]]; then
  echo "FAIL: the agent got ${received:-0} of ${LARGE_BYTES} bytes from its own listener, which closed the connection after writing them" >&2
  exit 1
fi
echo "PASS: the agent's own listener delivered a large response it closed at once"

# UDP has no handshake to stop, so a datagram from the agent to a UDP listener
# root owns must not arrive at all.
UDP_PROBE_LOG="$(mktemp)"
runuser -u root -- node -e '
  const socket = require("node:dgram").createSocket("udp4");
  socket.on("message", (message) => require("node:fs").appendFileSync(process.argv[2], message));
  socket.bind(Number(process.argv[1]), "127.0.0.1");
  setTimeout(() => process.exit(0), 4000);
' "$((LOOPBACK_PROBE_PORT + 2))" "$UDP_PROBE_LOG" &
sleep 1
runuser -u "$APP_USER" -- node -e '
  const socket = require("node:dgram").createSocket("udp4");
  socket.send("probe", Number(process.argv[1]), "127.0.0.1", () => socket.close());
' "$((LOOPBACK_PROBE_PORT + 2))" >/dev/null 2>&1 || true
sleep 1
if [[ -s "$UDP_PROBE_LOG" ]]; then
  rm -f "$UDP_PROBE_LOG"
  echo "FAIL: a datagram from the agent reached a loopback UDP listener another user owns" >&2
  exit 1
fi
rm -f "$UDP_PROBE_LOG"
echo "PASS: another user's loopback UDP listener blocked"

# An icmp reject in an inet table matches IPv4 only and leaves IPv6 at the
# chain's accept policy; the final reject must be icmpx.
if ! nft list chain inet agent_egress agent_out | grep -q 'reject with icmpx'; then
  echo "FAIL: the final reject does not cover IPv6" >&2
  exit 1
fi
echo "PASS: the final reject covers IPv6"

# What the agent does not send must not reach that reject. IPv6 neighbour
# discovery is sent by the kernel, owned by no user, and refusing it would cut
# the whole host off IPv6 once its neighbour entries expired. When the host
# has an IPv6 default route, root resolves the gateway afresh.
v6_gateway=""
v6_dev=""
read -r v6_gateway v6_dev < <(ip -6 route show default 2>/dev/null | awk '
  { for (i = 1; i < NF; i++) { if ($i == "via") gw = $(i + 1); if ($i == "dev") dev = $(i + 1) } }
  gw != "" && dev != "" { print gw, dev; exit }
') || true
if [[ -n "$v6_gateway" ]]; then
  ip -6 neigh del "$v6_gateway" dev "$v6_dev" 2>/dev/null || true
  ping -6 -c 1 -W 3 -I "$v6_dev" "$v6_gateway" >/dev/null 2>&1 || true
  if ! ip -6 neigh show "$v6_gateway" dev "$v6_dev" | grep -q lladdr; then
    echo "FAIL: root could not resolve the IPv6 gateway ${v6_gateway}; neighbour discovery is blocked" >&2
    exit 1
  fi
  echo "PASS: IPv6 neighbour discovery works for the host (gateway ${v6_gateway} resolved)"
else
  echo "SKIP: no IPv6 default route, so IPv6 neighbour discovery was not checked"
fi

if runuser -u "$APP_USER" -- env \
  HOME="$APP_DIR/runtime-home" \
  CONTAINER_HOST="$CONTAINER_HOST" \
  podman run --rm --network none node:24-bookworm-slim \
  node -e 'fetch("https://example.com").then(()=>process.exit(0),()=>process.exit(1))'; then
  echo "FAIL: sandbox with --network none reached the network" >&2
  exit 1
fi
echo "PASS: task container network disabled"
