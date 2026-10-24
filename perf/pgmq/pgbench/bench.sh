#!/bin/sh
# Runs inside the "bench" container (see ../compose.yaml): builds the pgbench scripts from
# their fragments and runs pgbench against one database. Called by run.sh.
#
#   bench.sh <worker|producer> <clients> <seconds> <database> [extra pgbench options]
#
# Parameters of the scripts, with their defaults, come from the environment:
#   VT=30 TRANSLATE_MS=2 DELIVER_MS=2 IDLE_INTAKE=1 IDLE_MS=10 SEED=1
set -eu

role=$1
clients=$2
seconds=$3
database=$4
shift 4

work=$(mktemp -d)
for script in worker producer; do
  sed -e '/@@INTAKE@@/{r /perf/pgbench/intake.frag.sql' -e 'd}' \
    "/perf/pgbench/$script.sql" >"$work/$script.sql"
done

threads=$clients
[ "$threads" -le 8 ] || threads=8

exec pgbench --no-vacuum --protocol=prepared --report-per-command --progress=10 \
  --client="$clients" --jobs="$threads" --time="$seconds" \
  --random-seed="${SEED:-1}" \
  --define="vt=${VT:-30}" \
  --define="translate_ms=${TRANSLATE_MS:-2}" \
  --define="deliver_ms=${DELIVER_MS:-2}" \
  --define="idle_intake=${IDLE_INTAKE:-1}" \
  --define="idle_ms=${IDLE_MS:-10}" \
  --file="$work/$role.sql" \
  "$@" "$database"
