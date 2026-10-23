#!/bin/sh
# Regenerates the Go code of contracts/ into services/connectors/internal/generated:
#   contracts/openapi/api.yaml            -> api/api.gen.go   (oapi-codegen: types and client)
#   contracts/jobs/job-envelope.schema.json -> jobs/jobs.gen.go (go-jsonschema: types)
# The generators are pinned in tools/codegen/go.mod and go.sum. With no local Go, or with
# USE_DOCKER=1, the script runs itself in the golang image of the version pinned in go.mod.
set -eu

cd "$(dirname "$0")/.."

if [ "${USE_DOCKER:-}" = 1 ] || ! command -v go >/dev/null 2>&1; then
  version=$(sed -n 's/^go \([0-9.]*\)$/\1/p' services/connectors/go.mod)
  exec docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e GOCACHE=/tmp/go-build \
    -e GOPATH=/tmp/go -e USE_DOCKER=0 -v "$PWD:/repo" -w /repo "golang:$version" scripts/generate-go.sh
fi

jobs=services/connectors/internal/generated/jobs
mkdir -p "$jobs"
go -C tools/codegen tool oapi-codegen -config oapi-codegen.yaml ../../contracts/openapi/api.yaml
go -C tools/codegen tool go-jsonschema --struct-name-from-title --tags json --capitalization ID \
  --package jobs --output "../../$jobs/jobs.gen.go" ../../contracts/jobs/job-envelope.schema.json
