#!/usr/bin/env bash
# Exploratory load test of PostgreSQL and pgmq. See docs/research/pgmq-load-test.md.
#
#   perf/pgmq/run.sh smoke      check that the SQL-only pgmq install works
#   perf/pgmq/run.sh matrix     closed loop, 1 / 4 / 8 workers, 3 runs each
#   perf/pgmq/run.sh open       open loop: a producer at a fixed rate, workers only consume
#   perf/pgmq/run.sh ceiling    closed loop without simulated external work
#   perf/pgmq/run.sh scale      closed loop with more workers than the matrix (16, 32)
#   perf/pgmq/run.sh nosync     the matrix loop with synchronous_commit = off (what-if)
#   perf/pgmq/run.sh soak       one long run, sampled every 30 s, for bloat and autovacuum
#   perf/pgmq/run.sh extra      ceiling, scale, nosync and open, in one go
#   perf/pgmq/run.sh all        smoke, matrix, extra, soak
#
# It builds the repository's own infra/postgres image, starts it in the Compose project
# "libredi-perf" (own network and volume, no published port), runs each measurement in a
# fresh database, and removes everything when it ends, whatever happens. Results are small
# CSV files in perf/pgmq/results/ (override with RESULTS_DIR). Needs Docker with Compose v2.
#
# Settings (environment): RUNS=3 WORKERS="1 4 8" WARMUP=15 MEASURE=60 TRANSLATE_MS=2
# DELIVER_MS=2 FILLFACTOR=100 OPEN_RATES="1:50 4:165 8:320 8:410" (workers:messages per
# second, about 70 % and 90 % of what the closed loop sustained on the reference host),
# REP_START=1 (number of the first repetition) CEILING_WORKERS="8 16 32" SCALE_WORKERS="16 32" NOSYNC_WORKERS="1 4 8" SOAK_WORKERS=8
# SOAK_SECONDS=600 SAMPLE_SECONDS=30.
set -euo pipefail

cd "$(dirname "$0")"

RUNS=${RUNS:-3}
REP_START=${REP_START:-1}
WORKERS=${WORKERS:-"1 4 8"}
WARMUP=${WARMUP:-15}
MEASURE=${MEASURE:-60}
COOLDOWN=5
TRANSLATE_MS=${TRANSLATE_MS:-2}
DELIVER_MS=${DELIVER_MS:-2}
FILLFACTOR=${FILLFACTOR:-100}
OPEN_RATES=${OPEN_RATES:-"1:50 4:165 8:320 8:410"}
CEILING_WORKERS=${CEILING_WORKERS:-"8 16 32"}
SCALE_WORKERS=${SCALE_WORKERS:-"16 32"}
NOSYNC_WORKERS=${NOSYNC_WORKERS:-"1 4 8"}
SOAK_WORKERS=${SOAK_WORKERS:-8}
SOAK_SECONDS=${SOAK_SECONDS:-600}
SAMPLE_SECONDS=${SAMPLE_SECONDS:-30}
RESULTS_DIR=${RESULTS_DIR:-results}

export COMPOSE_PROJECT_NAME=libredi-perf
export COMPOSE_PROFILES=bench
POSTGRES_PASSWORD="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export POSTGRES_PASSWORD

compose() { docker compose --file compose.yaml "$@"; }

# psql in the database container, on the Unix socket, as the superuser of the test cluster.
psql_db() {
  local db=$1
  shift
  compose exec -T postgres psql --username=libredi --dbname="$db" --no-psqlrc \
    --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align "$@"
}

# Same, with aligned output and headers, for the human-readable smoke check.
psql_show() {
  local db=$1
  shift
  compose exec -T postgres psql --username=libredi --dbname="$db" --no-psqlrc \
    --set=ON_ERROR_STOP=1 --quiet "$@"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  jobs -p | xargs -r kill 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    compose logs --no-color --tail 30 postgres >&2 || true
  fi
  compose down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT INT TERM

start_stack() {
  echo "Building and starting PostgreSQL ($COMPOSE_PROJECT_NAME)..."
  compose up --build --quiet-build --detach --wait --wait-timeout 180 postgres
}

mkdir -p "$RESULTS_DIR"

# ---------------------------------------------------------------------------------------
# Acceptance check: SQL-only pgmq, as a superuser and as a role with no privilege.
# ---------------------------------------------------------------------------------------
smoke() {
  local out="$RESULTS_DIR/smoke.txt"
  {
    echo "# pgmq SQL-only install check ($(date -u +%Y-%m-%dT%H:%MZ))"
    compose exec -T postgres postgres --version
    echo "# pgmq.sql sha256 (must match infra/postgres/Dockerfile):"
    compose exec -T postgres sha256sum /docker-entrypoint-initdb.d/10-pgmq.sql
    echo
    echo "## 1. The database created by the image at first start (superuser)"
    psql_show libredi --file=- <sql/05-smoke.sql
    echo
    echo "## 2. A fresh database, pgmq.sql run by hand as a superuser"
    psql_db postgres --command='create database perf_smoke_super'
    psql_db perf_smoke_super --file=/docker-entrypoint-initdb.d/10-pgmq.sql >/dev/null
    psql_show perf_smoke_super --file=- <sql/05-smoke.sql
    echo
    echo "## 3. A fresh database owned by a plain role (no superuser, no createrole, no createdb)"
    psql_db postgres --command="create role perf_plain login nosuperuser nocreaterole nocreatedb"
    psql_db postgres --command='create database perf_smoke_plain owner perf_plain'
    compose exec -T postgres psql --username=perf_plain --dbname=perf_smoke_plain --no-psqlrc \
      --set=ON_ERROR_STOP=1 --quiet --file=/docker-entrypoint-initdb.d/10-pgmq.sql >/dev/null
    compose exec -T postgres psql --username=perf_plain --dbname=perf_smoke_plain --no-psqlrc \
      --set=ON_ERROR_STOP=1 --quiet --file=- <sql/05-smoke.sql
  } 2>&1 | tee "$out"
  psql_db postgres --command='drop database perf_smoke_super' || true
  psql_db postgres --command='drop database perf_smoke_plain' || true
  psql_db postgres --command='drop role perf_plain' || true
  grep -c 'OK: pgmq SQL install works' "$out" | grep -qx 3 \
    || { echo "FAIL: the smoke check did not pass three times" >&2; exit 1; }
}

# CPU accounting of a measurement window, because the host is shared: cores busy on the whole
# host, cores used by this project's containers (cgroup counters), and the difference, which is
# what other processes of the host used meanwhile. cpu_sample prints "busy-jiffies
# our-cpu-microseconds epoch-seconds"; cpu_cores turns two samples into "host,test,other".
cpu_sample() {
  local id usec ours=0
  for id in $(docker ps --no-trunc --quiet --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"); do
    usec=$(awk '/^usage_usec/ {print $2}' "/sys/fs/cgroup/system.slice/docker-$id.scope/cpu.stat" 2>/dev/null || true)
    ours=$((ours + ${usec:-0}))
  done
  echo "$(awk '/^cpu / {print $2 + $3 + $4 + $7 + $8 + $9}' /proc/stat) $ours $(date +%s.%N)"
}
cpu_cores() {
  # shellcheck disable=SC2086
  set -- $1 $2
  awk -v b0="$1" -v o0="$2" -v t0="$3" -v b1="$4" -v o1="$5" -v t1="$6" 'BEGIN {
    dt = t1 - t0; host = (b1 - b0) / 100 / dt; test = (o1 - o0) / 1000000 / dt
    printf "%.1f,%.1f,%.1f", host, test, host - test }'
}

# ---------------------------------------------------------------------------------------
# One measured run in a fresh database.
#   run_one <mode> <workers> <rep> [<offered rate in messages per second>]
# mode: closed (workers also take in new messages), open (a producer at a fixed rate),
#       ceiling (closed, no simulated external work), soak (closed, long, sampled).
# ---------------------------------------------------------------------------------------
run_one() {
  local mode=$1 workers=$2 rep=$3 rate=${4:-}
  local id="${mode}-w${workers}-r${rep}"
  local db="perf_${mode}_w${workers}_r${rep}"
  local translate_ms=$TRANSLATE_MS deliver_ms=$DELIVER_MS idle_intake=1 measure=$MEASURE
  local sample=0
  [ "$mode" != ceiling ] || { translate_ms=0; deliver_ms=0; }
  [ "$mode" != open ] || idle_intake=0
  if [ "$mode" = soak ]; then measure=$SOAK_SECONDS; sample=$SAMPLE_SECONDS; fi
  local total=$((WARMUP + measure + COOLDOWN))

  echo "== $id: workers=$workers rate=${rate:-closed-loop} warmup=${WARMUP}s window=${measure}s"
  psql_db postgres --command="create database $db"
  # What-if: commits do not wait for the WAL flush (a crash can lose the last fraction of a
  # second of committed work). Shows how much of the time is the fsync.
  [ "$mode" != nosync ] || psql_db postgres --command="alter database $db set synchronous_commit = off"
  psql_db "$db" --file=/docker-entrypoint-initdb.d/10-pgmq.sql >/dev/null
  psql_db "$db" --set=ff="$FILLFACTOR" --file=- <sql/10-fixture.sql >/dev/null
  psql_db "$db" --command='select pg_stat_statements_reset()' >/dev/null
  psql_db "$db" --command="select perf.snap('start')" >/dev/null

  local load_before load_after
  load_before=$(cut -d' ' -f1-3 /proc/loadavg)

  local bench_env=(--env "TRANSLATE_MS=$translate_ms" --env "DELIVER_MS=$deliver_ms"
    --env "IDLE_INTAKE=$idle_intake" --env "IDLE_MS=10")
  local log="$RESULTS_DIR/.pgbench-$id.txt"
  compose run --rm -T --no-deps "${bench_env[@]}" bench worker "$workers" "$total" "$db" >"$log" 2>&1 &
  local pids=($!)
  if [ "$mode" = open ]; then
    compose run --rm -T --no-deps "${bench_env[@]}" bench producer 4 "$total" "$db" \
      --rate="$rate" >"$RESULTS_DIR/.producer-$id.txt" 2>&1 &
    pids+=($!)
  fi

  # The clock of the warm-up starts at the first message, not at the start of the container.
  local waited=0
  until [ "$(psql_db "$db" --command='select count(*) from fixture.messages')" -gt 0 ]; do
    sleep 0.3
    waited=$((waited + 1))
    [ "$waited" -lt 200 ] || { echo "no message after 60 s: see $log" >&2; exit 1; }
  done
  sleep "$WARMUP"
  psql_db "$db" --command="select perf.snap('w0')" >/dev/null
  local cpu0 cpu1 psi
  cpu0=$(cpu_sample)
  if [ "$sample" -gt 0 ]; then
    local elapsed=0 n=0
    while [ "$elapsed" -lt "$measure" ]; do
      sleep "$sample"
      elapsed=$((elapsed + sample))
      n=$((n + 1))
      psql_db "$db" --command="select perf.snap('$(printf 's%03d' "$n")')" >/dev/null
    done
  else
    sleep "$measure"
  fi
  psql_db "$db" --command="select perf.snap('w1')" >/dev/null
  cpu1=$(cpu_sample)
  psi=$(awk '/^some/ {split($3, a, "="); print a[2]}' /proc/pressure/cpu 2>/dev/null || true)
  wait "${pids[@]}" || { echo "pgbench failed: see $log" >&2; tail -20 "$log" >&2; exit 1; }
  load_after=$(cut -d' ' -f1-3 /proc/loadavg)
  sleep 3
  psql_db "$db" --command="select perf.snap('end')" >/dev/null

  psql_db "$db" --set=run_id="$id" --set=mode="$mode" --set=workers="$workers" \
    --set=rep="$rep" --set=rate="$rate" --file=- <sql/20-report-run.sql \
    | sed "s|\$|,\"$load_before\",\"$load_after\",$(cpu_cores "$cpu0" "$cpu1"),${psi:-}|" \
      >>"$RESULTS_DIR/runs.csv"
  psql_db "$db" --set=run_id="$id" --file=- <sql/21-report-tables.sql >>"$RESULTS_DIR/tables.csv"
  if [ "$rep" = 1 ]; then
    psql_db "$db" --set=run_id="$id" --file=- <sql/22-report-statements.sql \
      >>"$RESULTS_DIR/statements.csv"
    # pgbench's own report: per-command latency, kept for the first run of each setting.
    grep -vE '^progress:' "$log" >"$RESULTS_DIR/pgbench-$id.txt"
  fi
  if [ "$sample" -gt 0 ]; then
    psql_db "$db" --set=run_id="$id" --file=- <sql/23-report-timeline.sql \
      >>"$RESULTS_DIR/timeline.csv"
    # What autovacuum did to this database, from the server log, one row per vacuum.
    compose logs --no-color postgres 2>/dev/null \
      | awk -v db="$db" -f autovacuum-log.awk >"$RESULTS_DIR/autovacuum-$id.csv" || true
  fi
  rm -f "$log" "$RESULTS_DIR/.producer-$id.txt"
  psql_db postgres --command="drop database $db with (force)" >/dev/null
}

init_csv() {
  [ -s "$RESULTS_DIR/runs.csv" ] || echo \
    "run_id,mode,workers,rep,offered_msg_s,window_s,completed_in_window,msg_s,intake_msg_s,p50_ms,p95_ms,p99_ms,max_ms,in_flight_at_end,completed_total,redelivered_jobs,wal_bytes_per_msg,wal_records_per_msg,wal_fpi_per_msg,commits_per_msg,checkpoints,autovacuums,autoanalyzes,loadavg_before,loadavg_after,host_busy_cores,test_cores,other_cores,cpu_pressure_avg60" \
    >"$RESULTS_DIR/runs.csv"
  [ -s "$RESULTS_DIR/tables.csv" ] || echo \
    "run_id,kind,name,n_tup_ins,n_tup_upd,n_tup_del,n_tup_hot_upd,n_dead_tup_stat,autovacuum_count,heap_or_index_bytes,index_bytes,tuple_count,dead_tuple_count,dead_pct,free_pct,leaf_density_pct" \
    >"$RESULTS_DIR/tables.csv"
  [ -s "$RESULTS_DIR/statements.csv" ] || echo \
    "run_id,calls,total_ms,mean_ms,rows,wal_records,wal_bytes,query" >"$RESULTS_DIR/statements.csv"
  [ -s "$RESULTS_DIR/timeline.csv" ] || echo \
    "run_id,label,t_s,msg_s,p95_ms,queue_heap_bytes,queue_index_bytes,queue_dead_tup,queue_autovacuums,messages_heap_bytes,messages_dead_tup,messages_hot_upd,messages_upd" \
    >"$RESULTS_DIR/timeline.csv"
}

matrix() {
  local w rep
  for rep in $(seq "$REP_START" $((REP_START + RUNS - 1))); do
    for w in $WORKERS; do
      run_one closed "$w" "$rep"
    done
  done
}

open_loop() {
  local pair w
  local -A seen=()
  for pair in $OPEN_RATES; do
    w=${pair%%:*}
    seen[$w]=$((${seen[$w]:-0} + 1))
    run_one open "$w" "${seen[$w]}" "${pair##*:}"
  done
}

ceiling() {
  local w
  for w in $CEILING_WORKERS; do
    run_one ceiling "$w" 1
  done
}

# More workers than the main matrix, with the simulated external work: where it stops scaling.
scale() {
  local w
  for w in $SCALE_WORKERS; do
    run_one closed "$w" 1
  done
}

# Same loop as the main matrix, with synchronous_commit = off.
nosync() {
  local w
  for w in $NOSYNC_WORKERS; do
    run_one nosync "$w" 1
  done
}

soak() {
  run_one soak "$SOAK_WORKERS" 1
}

host_info() {
  {
    echo "date_utc: $(date -u +%Y-%m-%dT%H:%MZ)"
    echo "cpu: $(lscpu | sed -n 's/^Model name: *//p')"
    echo "vcpus: $(nproc)"
    echo "memory_mib: $(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)"
    echo "kernel: $(uname -sr)"
    echo "docker: $(docker --version)"
    echo "compose: $(docker compose version --short)"
    echo "loadavg_at_start: $(cut -d' ' -f1-3 /proc/loadavg)"
    echo "containers_running_on_host: $(docker ps -q | wc -l)"
    compose exec -T postgres postgres --version | sed 's/^/postgres: /'
    echo "postgres_settings: shared_buffers=$(psql_db libredi --command='show shared_buffers') max_wal_size=$(psql_db libredi --command='show max_wal_size') synchronous_commit=$(psql_db libredi --command='show synchronous_commit') fsync=$(psql_db libredi --command='show fsync') wal_compression=$(psql_db libredi --command='show wal_compression') autovacuum_naptime=$(psql_db libredi --command='show autovacuum_naptime') autovacuum_vacuum_scale_factor=$(psql_db libredi --command='show autovacuum_vacuum_scale_factor') autovacuum_vacuum_cost_delay=$(psql_db libredi --command='show autovacuum_vacuum_cost_delay') checkpoint_timeout=$(psql_db libredi --command='show checkpoint_timeout')"
    echo "pgmq: v1.13.1 from infra/postgres/Dockerfile, sha256 $(compose exec -T postgres sha256sum /docker-entrypoint-initdb.d/10-pgmq.sql | cut -d' ' -f1)"
  } >"$RESULTS_DIR/host.txt"
}

command=${1:-all}
case "$command" in
  smoke | matrix | open | ceiling | scale | nosync | soak | extra | all) ;;
  *) sed -n '2,15p' "$0" >&2; exit 2 ;;
esac

start_stack
init_csv
host_info
case "$command" in
  smoke) smoke ;;
  matrix) matrix ;;
  open) open_loop ;;
  ceiling) ceiling ;;
  scale) scale ;;
  nosync) nosync ;;
  soak) soak ;;
  extra) ceiling; scale; nosync; open_loop ;;
  all) smoke; matrix; extra; soak ;;
esac
echo "Done. Results in perf/pgmq/$RESULTS_DIR"
