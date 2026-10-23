#!/bin/sh
# Builds the image of one service, runs it locked down, and checks that it becomes healthy,
# does not run as root and stops cleanly on SIGTERM. Used by CI and by developers.
#
#   scripts/smoke-image.sh api|worker|translator|mcp|connectors
set -eu

service=${1:?usage: scripts/smoke-image.sh api|worker|translator|mcp|connectors}
root=$(cd "$(dirname "$0")/.." && pwd)
tag="libredi/$service:smoke"

case "$service" in
  connectors) docker build --tag "$tag" "$root/services/connectors" ;;
  api | worker | translator | mcp)
    docker build --tag "$tag" --file "$root/services/$service/Dockerfile" "$root"
    ;;
  *)
    echo "unknown service: $service" >&2
    exit 2
    ;;
esac

user=$(docker inspect --format '{{.Config.User}}' "$tag")
case "$user" in
  "" | 0 | 0:* | root | root:*)
    echo "$service: the image runs as root (USER='$user')" >&2
    exit 1
    ;;
esac

container=$(docker run --detach --read-only --cap-drop ALL \
  --security-opt no-new-privileges "$tag")
trap 'docker rm --force "$container" >/dev/null' EXIT

status=starting
for _ in $(seq 1 30); do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$container")
  if [ "$status" = healthy ] || [ "$status" = unhealthy ]; then
    break
  fi
  sleep 2
done
if [ "$status" != healthy ]; then
  echo "$service: not healthy (status: $status)" >&2
  docker logs "$container" >&2
  exit 1
fi

docker stop --time 15 "$container" >/dev/null
exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$container")
if [ "$exit_code" != 0 ]; then
  echo "$service: exit code $exit_code after SIGTERM, expected a clean 0" >&2
  docker logs "$container" >&2
  exit 1
fi

echo "$service: healthy, runs as '$user', stops cleanly on SIGTERM"
