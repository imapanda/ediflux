#!/bin/sh
# Starts the whole stack with three workers and checks the acceptance criteria:
# everything healthy, no service port on the host, routes through the proxy, network
# isolation, pgmq working.
# Runs in its own Compose project, so it never touches a developer's data.
#
#   scripts/smoke-compose.sh            (WORKERS=5 LIBREDI_PORT=18081 to change the defaults)
set -eu

cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=libredi-smoke
export LIBREDI_PORT="${LIBREDI_PORT:-18080}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
workers="${WORKERS:-3}"
base="http://127.0.0.1:$LIBREDI_PORT"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker compose ps --all >&2 || true
    docker compose logs --no-color --tail 40 >&2 || true
  fi
  docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

docker compose up --build --detach --scale "worker=$workers" --wait --wait-timeout 180

ps_json=$(docker compose ps --format json)

healthy_workers=$(echo "$ps_json" | jq -s '[.[] | select(.Service == "worker" and .Health == "healthy")] | length')
[ "$healthy_workers" -eq "$workers" ] || fail "expected $workers healthy workers, got $healthy_workers"

unhealthy=$(echo "$ps_json" | jq -rs '[.[] | select(.Health != "healthy") | .Service] | join(" ")')
[ -z "$unhealthy" ] || fail "containers not healthy: $unhealthy"

published=$(echo "$ps_json" | jq -rs '[.[] | select(.Service != "proxy") | .Publishers[]? | select(.PublishedPort != 0)] | length')
[ "$published" -eq 0 ] || fail "a service other than the proxy publishes a host port"

exposed=$(echo "$ps_json" | jq -rs '[.[] | select(.Service == "proxy") | .Publishers[]? | select(.PublishedPort != 0 and .URL != "127.0.0.1")] | length')
[ "$exposed" -eq 0 ] || fail "the proxy listens on an interface other than 127.0.0.1"

check_route() {
  path=$1
  expected=$2
  body=$(curl --fail --silent --show-error --max-time 5 "$base$path") || fail "GET $path failed"
  [ "$body" = "$expected" ] || fail "GET $path returned $body, expected $expected"
}
check_route /healthz ok
check_route /api/healthz '{"status":"ok","service":"api"}'
check_route /mcp/healthz '{"status":"ok","service":"mcp"}'

code=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "$base/worker/healthz")
[ "$code" = 404 ] || fail "internal service worker is reachable through the proxy (HTTP $code)"

code=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
  --header 'Host: attacker.example' "$base/api/healthz")
[ "$code" = 421 ] || fail "the proxy answered a foreign Host header (HTTP $code), expected 421"

# Who can reach whom, from inside the containers (the images have Node.js, not nc).
can_connect() {
  docker compose exec -T "$1" node -e "
    const socket = require('node:net').connect($3, '$2');
    socket.on('connect', () => process.exit(0));
    socket.on('error', () => process.exit(1));
    setTimeout(() => process.exit(1), 3000);
  " >/dev/null 2>&1
}
can_connect worker postgres 5432 || fail "worker cannot reach postgres"
can_connect worker translator 8080 || fail "worker cannot reach translator"
can_connect api postgres 5432 || fail "api cannot reach postgres"
! can_connect translator postgres 5432 || fail "translator can reach postgres: it must not"
! can_connect mcp postgres 5432 || fail "mcp can reach postgres: it must not"

queued=$(docker compose exec -T postgres psql --username=libredi --dbname=libredi \
  --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet <<'SQL'
select pgmq.create('smoke');
select pgmq.send('smoke', '{"hello": "world"}'::jsonb);
select message ->> 'hello' from pgmq.read('smoke', 30, 1);
select pgmq.drop_queue('smoke');
SQL
)
echo "$queued" | grep -qx world || fail "pgmq did not return the message it was sent: $queued"

echo "OK: $workers workers healthy, no service port on the host, routes, isolation and pgmq working"
