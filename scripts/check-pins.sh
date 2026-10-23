#!/bin/sh
# Checks that the Node.js, pnpm, Go and Biome versions pinned in several files agree.
# Dependabot bumps some of them (Dockerfiles, npm) and not the others: this catches the drift.
set -eu

cd "$(dirname "$0")/.."

status=0
expect() {
  # expect <what> <expected> <found>
  if [ "$2" != "$3" ]; then
    echo "MISMATCH $1: expected '$2', found '$3'" >&2
    status=1
  fi
}

node=$(tr -d '[:space:]' <.nvmrc)
node_major=${node%%.*}
pnpm=$(sed -n 's/.*"packageManager": "pnpm@\([0-9.]*\)".*/\1/p' package.json)
go=$(sed -n 's/^go \([0-9.]*\)$/\1/p' services/connectors/go.mod)
biome=$(sed -n 's/^  "@biomejs\/biome": \(.*\)$/\1/p' pnpm-workspace.yaml)

expect "engines.node in package.json" ">=$node <$((node_major + 1))" \
  "$(sed -n 's/.*"node": "\([^"]*\)".*/\1/p' package.json)"
expect "engines.pnpm in package.json" ">=$pnpm <$((${pnpm%%.*} + 1))" \
  "$(sed -n 's/.*"pnpm": "\([^"]*\)".*/\1/p' package.json)"
expect "@types/node major in pnpm-workspace.yaml" "$node_major" \
  "$(sed -n 's/^  "@types\/node": \([0-9]*\)\..*/\1/p' pnpm-workspace.yaml)"
expect "Biome version in biome.json \$schema" "$biome" \
  "$(sed -n 's#.*biomejs.dev/schemas/\([0-9.]*\)/schema.json.*#\1#p' biome.json)"
expect "Node.js in the devcontainer" "$node" \
  "$(sed -n '/features\/node/,/}/s/.*"version": "\([^"]*\)".*/\1/p' .devcontainer/devcontainer.json)"
expect "Go in tools/codegen/go.mod" "$go" \
  "$(sed -n 's/^go \([0-9.]*\)$/\1/p' tools/codegen/go.mod)"
expect "Go in the devcontainer" "$go" \
  "$(sed -n '/features\/go/,/}/s/.*"version": "\([^"]*\)".*/\1/p' .devcontainer/devcontainer.json)"
expect "pnpm in the devcontainer" "$pnpm" \
  "$(sed -n 's/.*install --global pnpm@\([0-9.]*\).*/\1/p' .devcontainer/devcontainer.json)"

for dockerfile in services/api services/worker services/translator services/mcp; do
  file="$dockerfile/Dockerfile"
  expect "Node.js images in $file" "node:$node-alpine" \
    "$(grep -o 'node:[0-9.]*-alpine' "$file" | sort -u | tr '\n' ' ' | sed 's/ $//')"
  expect "pnpm in $file" "pnpm@$pnpm" "$(grep -o 'pnpm@[0-9.]*' "$file" | sort -u | tr '\n' ' ' | sed 's/ $//')"
  expect "esbuild target in $dockerfile/package.json" "--target=node$node_major" \
    "$(grep -o -e '--target=node[0-9]*' "$dockerfile/package.json")"
done
expect "Go image in services/connectors/Dockerfile" "golang:$go-alpine" \
  "$(grep -o 'golang:[0-9.]*-alpine' services/connectors/Dockerfile | sort -u)"

for version in "$node" "$pnpm" "$go"; do
  grep -q -F "$version" docs/development.md || {
    echo "MISMATCH docs/development.md does not mention $version" >&2
    status=1
  }
done

if [ "$status" -eq 0 ]; then
  echo "Pinned versions agree: Node.js $node, pnpm $pnpm, Go $go, Biome $biome."
fi
exit "$status"
