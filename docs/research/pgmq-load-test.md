# Research: PostgreSQL and pgmq load test

> Exploratory draft of **2026-10-24** for [issue #184](https://github.com/imapanda/libredi/issues/184),
> "Load-test PostgreSQL and pgmq before the reliable core". It reports measurements, not
> decisions: nothing here changes an ADR, and the fixture schema used for the test is **not** a
> schema proposal. The numbers come from one shared, noisy machine and are indicative.

## What this is, and what it is not

[ADR 10](../adr/0010-service-boundaries-and-communication.md) puts every asynchronous step on
pgmq queues in PostgreSQL, installed in its SQL-only form, and states that the system's
throughput ceiling is PostgreSQL (writes per state transition, queue churn, vacuum) rather than
the language of the services. It asks for a load test with the real number of writes per
message before milestone 3. This page is the first pass of that test:

- a reproducible harness ([`perf/pgmq`](../../perf/pgmq/run.sh)) that runs the repository's own
  PostgreSQL image and measures a realistic per-message write pattern with 1, 4 and 8 competing
  workers;
- the raw results and what they suggest;
- what could not be verified, and questions for the M3 schema design.

It is not a benchmark of PostgreSQL in general, not a capacity plan, and not a verdict on
pgmq: one host, one configuration, one throwaway schema, and runs of one to ten minutes.

## Method

### Setup

- **Database**: the image built from [`infra/postgres`](../../infra/postgres/Dockerfile) (PostgreSQL
  18.6 on Alpine, pgmq v1.13.1 installed by running its SQL file, no extension). It runs in a
  dedicated Compose project (`libredi-perf`, own network and volume, no published port), so it
  never touches the stack of the root `compose.yaml`.
- **Settings**: the image's defaults (for example `shared_buffers` 128 MB, `max_wal_size` 1 GB,
  `synchronous_commit` on, `fsync` on, autovacuum with its defaults: one-minute naptime, scale
  factor 0.2, cost delay 2 ms). The only changes are instrumentation: `log_autovacuum_min_duration=0`,
  `track_io_timing`, and `pg_stat_statements` (with `track=all`, which has a small cost, the same in
  every run).
- **Load generator**: `pgbench` from the same image, in a second container on the same network,
  talking to PostgreSQL over TCP with the extended (prepared) protocol, like the services will.
  Each worker is one pgbench client running a polling loop written in pgbench's scripting
  language ([`worker.sql`](../../perf/pgmq/pgbench/worker.sql)). It needs nothing but the
  repository's image.
- **Fresh database per run**, created from scratch (the pgmq SQL file, then the fixture), dropped
  at the end. The containers, network and volume are removed when the script exits, whatever the
  outcome; only the image tag `libredi-perf/postgres:local` stays, as a build cache
  (`docker rmi libredi-perf/postgres:local` removes it).

### The write pattern of one message

Modelled on the [message lifecycle and reliability model](../architecture.md) and on ADR 5 and
10. There is no real schema yet, so a plain throwaway one stands in
([`10-fixture.sql`](../../perf/pgmq/sql/10-fixture.sql), marked as a test fixture, not a migration).
The state change and the job it triggers are always in the same transaction. The external work
(the translator call, the write to the destination) is simulated by a 2 ms sleep outside any
transaction, a stated assumption: 2 ms is the translator objective of 500 messages per second
per core in ADR 10.

| Step | Transactions | pgmq calls | Rows written by the step |
| --- | --- | --- | --- |
| Intake (api) | 1 | `send` (translate) | 1 `messages` insert with its duplicate-detection keys, 1 `archive_refs` insert (raw file) |
| Translate (worker) | claim, then 1 | `read` (vt 30 s), `archive`, `send` (deliver) | 1 `messages` update, 3 `transitions` (parsed, validated, mapped), 1 `archive_refs` insert (rendered file) |
| Deliver (worker) | claim, then 1 | `read`, `archive`, `send` (acknowledge) | 1 `messages` update, 1 `transition` (delivered) |
| Acknowledge (worker) | claim, then 1 | `read`, `archive` | 1 `messages` update, 1 `transition` (acknowledged) |

Per message: **4 write transactions plus 3 claim transactions** (a `pgmq.read` is itself an
`UPDATE` of the job row), 3 sends, 3 reads, 3 archives, 1 insert and 3 updates of the message
row, 5 transition rows, 2 archive references. The `messages` table carries a primary key and two
unique indexes (interchange key, content hash); `transitions` and `archive_refs` have foreign keys
to it. Job payloads are about 300 bytes of JSON (type, version, message id, archive hash,
`traceparent`), as in ADR 10.

### Two ways of loading it

- **Closed loop** (the headline numbers). N workers, nothing else. A worker claims the next job,
  trying the last pipeline stage first (so work in flight drains before new messages enter); if no
  queue has a job, it takes in a new message itself. The system runs saturated, the in-flight
  count stays about N, and the throughput is what N workers can sustain. The cost of this model:
  latency is close to the service time, since nothing waits in a queue. It also includes the cost
  of polling empty queues, because a worker that has nothing to do polls up to three queues
  before it takes in a message.
- **Open loop**. A separate producer (the api) injects messages at a fixed rate; N workers only
  consume (and sleep 10 ms when idle). This shows end-to-end latency with a real queue, at a rate
  below saturation.

Three more kinds of run, one run each: **ceiling** (the closed loop without the simulated
external work, with 8 to 64 workers, to see where PostgreSQL itself saturates), **scale** (the
closed loop with 16 and 32 workers), and a **what-if** with `synchronous_commit = off`, to see how
much of the time is waiting for the WAL flush. One **soak** run keeps 8 workers going for 10
minutes and samples the tables every 30 seconds, to see whether bloat and autovacuum stabilize.

### What is measured

- **Throughput**: messages that reached the last state inside a measurement window (15 s warm-up
  excluded, then 60 s), divided by the window length. Window edges are database clock readings.
- **End-to-end latency** of each message completed in the window: from the start of its intake
  transaction to the commit-time stamp of its last transition, both read from the database
  clock (so they carry about a millisecond of slack at each end). Percentiles are exact
  (`percentile_cont` over every message of the window).
- **Writes per message** from PostgreSQL's own counters: WAL bytes, WAL records and full-page
  images (`pg_stat_wal`), commits (`pg_stat_database`), per-table inserts, updates, deletes and HOT
  updates (`pg_stat_user_tables`), and the most expensive statements (`pg_stat_statements`).
- **Bloat** at the end of each run, before any manual `VACUUM`: exact dead-tuple percentage and
  free-space percentage from `pgstattuple`, index size and leaf density from `pgstatindex`,
  relation sizes, and autovacuum counts.
- **Repetition**: each closed-loop setting of the main matrix runs **3 times**, interleaved (1, 4,
  8, 1, 4, 8, ...) so that slow drifts of the host spread over all settings; a fourth repetition
  was added at the end, once the CPU accounting below existed, and is part of the medians. Tables
  give the median and, in brackets, the minimum and maximum.
- **The host is shared**, so every run records the load average before it and, for the runs after
  the first nine, the cores used by the test (cgroup counters of the two containers) and by
  everything else (host CPU time minus the test's), plus the CPU pressure (`/proc/pressure/cpu`).

### Reproduce

```bash
perf/pgmq/run.sh smoke     # SQL-only pgmq works (about 1 minute)
perf/pgmq/run.sh matrix    # closed loop, 1/4/8 workers, 3 runs each (about 15 minutes)
perf/pgmq/run.sh open      # open loop at fixed rates
perf/pgmq/run.sh extra     # ceiling, scale, synchronous_commit off, and open loop
perf/pgmq/run.sh soak      # one 10-minute run, sampled every 30 s
perf/pgmq/run.sh all       # smoke, matrix, extra and soak (about an hour)
python3 -I perf/pgmq/summarize.py   # Markdown tables from perf/pgmq/results/*.csv
```

Settings (workers, durations, simulated work, fillfactor, rates) are environment variables,
listed at the top of [`run.sh`](../../perf/pgmq/run.sh). It needs Docker with Compose v2 and
network access once, to pull the pinned base image and to download the checksummed pgmq file at
build time.

## Results

All numbers below are produced by `run.sh` and summarized by `summarize.py` from the CSV files
in [`perf/pgmq/results`](../../perf/pgmq/results/). Tables give the median and, in brackets, the
minimum and maximum of the runs of one setting.

### Machine

A shared, noisy host (the numbers carry that noise, see "Limits"):

| | |
| --- | --- |
| CPU | AMD EPYC 9R45, 16 vCPU (1 thread per core), x86_64, an AWS virtual machine (instance type not queried) |
| Memory | 61 GiB |
| Disk | Amazon Elastic Block Store volume (NVMe interface; volume type and provisioned IOPS not queried); the Docker data root is on the root volume |
| OS and Docker | Linux 7.0.0 (AWS kernel), Docker 29.1.3, Compose 2.40.3 |
| PostgreSQL, pgmq | PostgreSQL 18.6 (Alpine image of `infra/postgres`), pgmq v1.13.1 (SQL file, sha256 `e861fcbd...463642`) |
| Other work on the host | About 17 other containers (mostly idle) and, at times, test runs of other projects of the same user: see "Limits" |

The exact settings are in [`results/host.txt`](../../perf/pgmq/results/host.txt).

### SQL-only pgmq works (first acceptance criterion of #184)

`run.sh smoke` ([output](../../perf/pgmq/results/smoke.txt)) runs one assertion script
([`05-smoke.sql`](../../perf/pgmq/sql/05-smoke.sql)) after three installs of the same
checksummed `pgmq.sql`:

1. the database the image creates at its first start (the entrypoint runs the file);
2. a fresh database, the file run by hand by a superuser;
3. a fresh database owned by a **plain role** (no superuser, no `CREATEROLE`, no `CREATEDB`),
   which is the closest this machine gets to what an application owner has on a managed
   PostgreSQL.

All three pass. No pgmq extension exists or is needed (`pg_extension` and
`pg_available_extensions` list none). The assertions cover `create`, `send`, delayed `send`,
`send_batch`, `read` with a visibility timeout (a leased message is invisible to another
consumer; once the lease expires it returns with `read_ct` 2), `archive`, `delete`, `metrics`
and `drop_queue`. Each of the 26 load-test runs also installed the same file into a fresh
database and ended without an error or a redelivered job (`redelivered_jobs` is 0 in every run).

This does **not** verify a managed PostgreSQL: see "What could not be verified".

### Closed loop, 1 / 4 / 8 workers

Median [min-max] of 4 runs for 1, 4 and 8 workers; single runs for 16 and 32.

| workers | runs | messages/s | p50 ms | p95 ms | p99 ms | max ms | WAL bytes/msg | commits/msg |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 4 | 73.6 [69.4-73.8] | 11.9 [11.9-12.5] | 12.2 [12.2-13.7] | 12.8 [12.7-16.5] | 23 [19-32] | 7300 [7246-7322] | 13.0 [13.0-13.0] |
| 4 | 4 | 231.9 [226.4-235.9] | 14.6 [14.6-14.9] | 16.0 [15.6-16.3] | 18.3 [17.6-20.7] | 34 [32-875] | 7244 [7236-7250] | 13.0 [13.0-13.0] |
| 8 | 4 | 434.6 [377.9-458.0] | 15.2 [14.7-15.8] | 18.7 [15.8-24.9] | 21.6 [17.1-28.9] | 36 [27-44] | 7240 [7239-7241] | 13.0 [13.0-13.0] |
| 16 | 1 | 890.3 | 15.3 | 16.5 | 20.3 | 62 | 7238 | 13.0 |
| 32 | 1 | 1579.8 | 16.9 | 20.2 | 26.8 | 75 | 8424 | 13.0 |

What the raw runs show:

- Throughput grows almost linearly with the number of workers (about 54 to 74 messages per
  second per worker): at 8 workers the test used 1.6 of the 16 cores (run 4, the only one with
  CPU accounting at that size), mostly waiting, so neither PostgreSQL nor the CPUs were
  saturated. The limit of this setup at 1 to 8 workers is the sequential latency of one message
  in one worker, not PostgreSQL.
- End-to-end latency is flat (median p95 of 12, 16 and 19 ms), because the loop is saturated
  with about as many messages in flight as workers: it is the service time of a message, not a
  queueing delay. It is a floor, not a promise: see the open loop below for latency with a
  real queue.
- Run-to-run spread is a few percent, except for run 4 of 8 workers, which shared the host with
  7.3 cores of other processes and sustained 378 messages per second with a p95 of 25 ms instead
  of 428 to 458 and 16 to 19 ms. The other runs were not protected from the other tenants of the
  host either (see "Limits").

Every run. The first nine have no CPU accounting; run 4 of 8 workers shared the host with 7.3
cores of other work. `autovacuums` counts the autovacuum passes over all the tables of the
database during the run:

| run | offered msg/s | completed in window | messages/s | p50 ms | p95 ms | p99 ms | in flight at end | autovacuums | load average (1/5/15 min) before | cores used by the test / by others |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| closed-w1-r1 | closed loop | 4425 | 73.7 | 11.9 | 12.2 | 12.7 | 1 | 9 | 1.57 4.56 6.70 | not recorded |
| closed-w4-r1 | closed loop | 14084 | 234.4 | 14.6 | 15.8 | 18.1 | 2 | 16 | 1.36 3.75 6.23 | not recorded |
| closed-w8-r1 | closed loop | 27514 | 458.0 | 14.7 | 15.8 | 17.1 | 6 | 18 | 2.29 3.39 5.88 | not recorded |
| closed-w1-r2 | closed loop | 4417 | 73.5 | 11.9 | 12.2 | 12.8 | 1 | 9 | 3.26 3.42 5.68 | not recorded |
| closed-w4-r2 | closed loop | 13780 | 229.4 | 14.9 | 16.3 | 18.5 | 3 | 18 | 2.04 2.96 5.31 | not recorded |
| closed-w8-r2 | closed loop | 25741 | 428.4 | 15.6 | 18.4 | 20.8 | 7 | 18 | 5.04 3.72 5.37 | not recorded |
| closed-w1-r3 | closed loop | 4169 | 69.4 | 12.5 | 13.7 | 16.5 | 1 | 12 | 9.76 5.47 5.84 | not recorded |
| closed-w4-r3 | closed loop | 14170 | 235.9 | 14.6 | 15.6 | 17.6 | 3 | 18 | 6.51 5.91 5.99 | not recorded |
| closed-w8-r3 | closed loop | 26491 | 440.9 | 14.8 | 19.0 | 22.4 | 6 | 18 | 4.35 5.23 5.73 | not recorded |
| closed-w16-r1 | closed loop | 53501 | 890.3 | 15.3 | 16.5 | 20.3 | 14 | 9 | 7.95 4.85 5.94 | 3.3 / 1.1 |
| closed-w32-r1 | closed loop | 94953 | 1579.8 | 16.9 | 20.2 | 26.8 | 27 | 18 | 5.68 4.90 5.86 | 6.6 / 0.7 |
| closed-w1-r4 | closed loop | 4437 | 73.8 | 11.9 | 12.2 | 12.8 | 1 | 9 | 8.91 6.09 6.19 | 0.2 / 1.5 |
| closed-w4-r4 | closed loop | 13606 | 226.4 | 14.6 | 16.2 | 20.7 | 3 | 15 | 7.54 6.33 6.27 | 0.8 / 2.3 |
| closed-w8-r4 | closed loop | 22739 | 377.9 | 15.8 | 24.9 | 28.9 | 5 | 18 | 9.87 7.36 6.63 | 1.6 / 7.3 |

#### Where the time of one message goes

One worker, no contention (`closed-w1`, 13.6 ms per message, from `pgbench -r` and
`pg_stat_statements`):

| Part | Per message |
| --- | --- |
| Simulated external work (2 sleeps of 2 ms) | 4.1 ms |
| 7 write commits (4 transactions and 3 claims), at about 0.96 ms each, mostly the WAL flush to the EBS volume | about 6.7 ms |
| 3 successful claims, 6 empty polls (9 `pgmq.read` per message), and the other statements, with their round trips on the Docker network (about 0.1 to 0.5 ms each, 32 statements) | about 2.8 ms |

Half of the time of a message is waiting for the WAL flush, and two thirds of the `pgmq.read`
calls of the closed loop return nothing. At 8 workers a commit takes 1.3 to 1.7 ms (group commit
shares the flush, but the queue for it grows). A different design could change both numbers; the
what-if runs below show how much.

### Open loop: latency with a real queue

A producer (the api) injects messages at a fixed rate, the workers only consume (and sleep 10 ms
when all three queues are empty). The rates are about 70 % of what the closed loop sustained
with 1, 4 and 8 workers, and 94 % for the last run.

| run | offered msg/s | completed in window | messages/s | p50 ms | p95 ms | p99 ms | in flight at end | autovacuums | load average (1/5/15 min) before | cores used by the test / by others |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| open-w1-r1 | 50 | 2964 | 49.3 | 22.3 | 55.8 | 79.0 | 1 | 9 | 2.86 5.54 9.67 | 0.2 / 0.2 |
| open-w4-r1 | 165 | 9741 | 162.1 | 18.5 | 27.9 | 34.0 | 3 | 15 | 1.22 4.33 8.87 | 0.5 / 0.5 |
| open-w8-r1 | 320 | 19325 | 321.5 | 17.2 | 23.0 | 26.9 | 13 | 18 | 1.21 3.57 8.21 | 1.1 / 0.2 |
| open-w8-r2 | 410 | 24881 | 414.0 | 18.9 | 28.3 | 34.2 | 4 | 18 | 1.72 3.13 7.64 | 1.3 / 0.1 |

Every offered message was completed in the window (the completed rate equals the offered rate
within 1 to 3 %), and the backlog at the end of each run was at most 13 messages. End-to-end p95
stays between 23 and 56 ms and p99 between 27 and 79 ms; p50 is 17 to 22 ms, a few milliseconds
above the closed loop because a message that arrives while the workers sleep waits for the next
poll. The largest figures are those of the single worker, at 68 % of its capacity, where a message
sometimes waits behind another. The objective of ADR 10 (95 % of messages delivered within 5 s of
receipt at nominal load) is more than a hundred times further away than these numbers, but they
leave out everything outside PostgreSQL (the real translator and ERP calls, the transports) and
the behaviour above capacity, which was not tested.

### How far it scales, and what limits it

The main matrix stops at 8 workers, as the issue asks. Throughput had not flattened there, so
single extra runs go further, and two what-if runs show what the commits cost:

| Workers | Closed loop, 4 ms of simulated work | No simulated work | `synchronous_commit = off`, 4 ms of simulated work |
| --- | --- | --- | --- |
| 1 | 73.6 | n/a | 145.6 |
| 4 | 231.9 | n/a | 559.0 |
| 8 | 434.6 | 597.8 | 1,092.1 |
| 16 | 890.3 | 1,100.5 | n/a |
| 32 | 1,579.8 | 1,859.0 | n/a |
| 64 | n/a | 1,924.8 | n/a |

(Medians of 4 runs for 1, 4 and 8 workers in the first column; single runs elsewhere. The
`synchronous_commit = off` column is a what-if about where the time goes: it lets a crash lose
the last fraction of a second of committed work, which a reliable core may not accept; it is not
a recommendation.)

- Up to 32 workers throughput kept growing (1,859 messages per second without simulated work,
  with the test using 7.5 of the 16 cores). The processes mostly wait for the WAL flush, and group
  commit lets more concurrent workers share the same flushes. At 64 workers it reached 1,925
  messages per second (about 14 MB/s of WAL) and p95 rose to 38 ms: the CPUs of the host were
  then saturated (13.8 of 16 cores busy, 5.2 of them used by other processes). That is the limit
  of this shared host, not a measured limit of PostgreSQL.
- Asynchronous commit multiplies the throughput of the same number of workers by 2.0 (1 worker),
  2.4 (4) and 2.5 (8), and halves the latency, so the flush is the main cost of this pattern with
  few workers. What it would be on another disk, or with a synchronous standby, is the first
  thing to measure on the target platform.
- Removing the 4 ms of simulated work raises 8 workers from 435 to 598 messages per second
  (+37 %): most of the time of a worker is the database round trips and commits, not the
  external call.

### Writes per message

The write pattern is the same at 1, 4 and 8 workers (the run-to-run figures differ by less than
1 %), so these are properties of the pattern, not of the load.

| Per completed message | Measured |
| --- | --- |
| Transactions committed (`pg_stat_database`) | 13, of which 7 write (4 explicit, 3 claims) and 6 are empty polls |
| WAL | about 7.3 KB, 73 records (about 8.1 KB in the 10-minute run, where 4 checkpoints brought full-page images back: 0.12 per message instead of 0.01) |
| Rows | 1 insert and 3 updates (`messages`), 5 `transitions`, 2 `archive_refs`; in the queues 3 inserts, 3 updates, 3 deletes, and 3 inserts into the archives |
| Disk, heap plus indexes, after the run | about 2.6 to 2.9 KB: see the storage table below |

Where the WAL goes, for one worker (top-level statements of `pg_stat_statements`, so nested ones
are not counted twice; the foreign-key row locks, about 0.25 KB, are included in the inserts that
trigger them):

| Operation (per message) | WAL |
| --- | --- |
| 3 × `pgmq.archive` (delete from the queue, insert into the archive with its 2 index entries) | 1.6 KB |
| 5 `transitions` rows (two statements) | 1.4 KB |
| 3 × `pgmq.send` | 1.4 KB |
| 3 claims (`pgmq.read`, an `UPDATE` of the job row) | 0.9 KB |
| 1 `messages` insert (primary key, 2 unique indexes) | 0.7 KB |
| 2 `archive_refs` rows | 0.5 KB |
| 3 `messages` updates | 0.2 KB |
| Commit records and the rest | 0.3 KB |

The three archive tables of pgmq are the largest single item, followed by the transitions. The
archives keep a full copy of every job payload (about 300 bytes of JSON) for ever unless something
removes them.

Storage per completed message (bytes, heap plus indexes) at the end of the run, median over the
runs of a setting:

| mode | workers | messages | transitions | archive_refs | pgmq archives (3) | pgmq queues (3) | total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| closed | 1 | 482 [477-484] | 608 [608-611] | 328 [327-329] | 1139 [1138-1144] | 291 [273-321] | 2848 [2833-2881] |
| closed | 4 | 504 [502-507] | 605 [605-605] | 326 [325-326] | 1129 [1128-1129] | 289 [285-295] | 2853 [2847-2860] |
| closed | 8 | 512 [509-514] | 604 [604-604] | 326 [325-326] | 1126 [1126-1127] | 295 [289-301] | 2863 [2856-2870] |
| soak | 8 | 514 | 603 | 324 | 1121 | 43 | 2606 |

### Queue churn, bloat and autovacuum

Each message makes three jobs go through insert, update (the claim, which changes `vt`, an
indexed column, so it can never be a HOT update), delete and insert into the archive: about six
dead tuples per message in the queue tables, so 2.7 thousand per second at 450 messages per
second.

**In the 80-second runs** (table below, before any manual `VACUUM`): the queue heaps stay small
(0.8 MB at 4 workers, 1.5 MB at 8, 94 to 95 % free space, 2 to 3 % dead tuples), because pages are
pruned when they are read, and autovacuum made two passes per table. The `vt` indexes grow
instead (about 1 MB per queue at 4 workers, 1.9 MB at 8), with a leaf density around 62 %.
`n_dead_tup` is a poor indicator for these tables: it says tens of thousands of dead tuples while
the exact count from `pgstattuple` is a few dozen.

| mode | workers | table | heap KiB | indexes KiB | updates | HOT updates | dead tuples % | free space % | autovacuums |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| closed | 1 | fixture.messages | 1240 [1128-1240] | 1532 [1368-1544] | 17658 [16086-17669] | 17558 [16004-17561] | 0.1 [0.1-0.1] | 3.2 [3.0-3.2] | 1 [1-1] |
| closed | 1 | pgmq.q_acknowledge | 52 [24-80] | 412 [336-416] | 5886 [5362-5889] | 0 [0-0] | 8.6 [7.0-12.0] | 78.2 [73.5-78.6] | 1 [1-2] |
| closed | 1 | pgmq.q_deliver | 276 [72-304] | 392 [384-400] | 5886 [5362-5890] | 0 [0-0] | 2.2 [1.8-6.7] | 94.3 [79.0-96.5] | 1 [1-2] |
| closed | 1 | pgmq.q_translate | 232 [24-304] | 392 [352-416] | 5886 [5362-5890] | 0 [0-0] | 2.3 [0.3-4.0] | 93.2 [81.6-96.2] | 1 [1-2] |
| closed | 4 | fixture.messages | 3900 [3840-3976] | 5220 [5088-5360] | 55538 [54601-56610] | 55086 [54140-56058] | 0.2 [0.0-0.2] | 3.2 [3.1-3.2] | 2 [2-2] |
| closed | 4 | pgmq.q_acknowledge | 788 [752-800] | 968 [912-1000] | 18512 [18199-18869] | 0 [0-0] | 2.3 [1.3-2.8] | 93.8 [93.2-95.6] | 2 [2-2] |
| closed | 4 | pgmq.q_deliver | 780 [752-808] | 948 [904-1016] | 18513 [18200-18870] | 0 [0-0] | 2.2 [2.0-2.2] | 93.9 [93.8-94.7] | 2 [2-2] |
| closed | 4 | pgmq.q_translate | 784 [768-808] | 980 [928-1000] | 18514 [18202-18871] | 0 [0-0] | 1.9 [1.2-2.2] | 94.4 [94.0-95.6] | 2 [2-2] |
| closed | 8 | fixture.messages | 7408 [6560-7712] | 10128 [8888-10600] | 105209 [93213-109685] | 104088 [92171-108646] | 0.2 [0.1-0.3] | 3.3 [3.2-3.4] | 2 [2-2] |
| closed | 8 | pgmq.q_acknowledge | 1480 [1320-1552] | 1840 [1704-2024] | 35067 [31070-36559] | 0 [0-0] | 2.3 [2.2-2.7] | 95.4 [95.1-95.5] | 2 [2-2] |
| closed | 8 | pgmq.q_deliver | 1476 [1320-1536] | 1856 [1704-2048] | 35069 [31070-36562] | 0 [0-0] | 2.7 [2.4-2.8] | 95.1 [94.5-95.6] | 2 [2-2] |
| closed | 8 | pgmq.q_translate | 1468 [1320-1560] | 1796 [1728-2032] | 35073 [31073-36564] | 0 [0-0] | 2.5 [1.9-3.4] | 95.1 [94.3-95.7] | 2 [2-2] |
| soak | 8 | fixture.messages | 58952 | 82232 | 843231 | 826878 | 0.0 | 2.8 | 8 |
| soak | 8 | pgmq.q_acknowledge | 1608 | 2152 | 281075 | 0 | 4.0 | 94.6 | 10 |
| soak | 8 | pgmq.q_deliver | 1888 | 2136 | 281077 | 0 | 1.4 | 97.3 | 10 |
| soak | 8 | pgmq.q_translate | 1832 | 2120 | 281079 | 0 | 2.2 | 96.4 | 10 |

The visibility-timeout index of each queue:

| mode | workers | index | size KiB | leaf density % |
| --- | --- | --- | --- | --- |
| closed | 1 | pgmq.q_acknowledge_vt_idx | 372 [256-384] | 66.7 [62.2-72.7] |
| closed | 1 | pgmq.q_deliver_vt_idx | 364 [328-384] | 66.8 [57.1-73.0] |
| closed | 1 | pgmq.q_translate_vt_idx | 364 [320-384] | 67.0 [62.3-73.2] |
| closed | 4 | pgmq.q_acknowledge_vt_idx | 916 [872-960] | 62.0 [60.7-63.5] |
| closed | 4 | pgmq.q_deliver_vt_idx | 908 [864-976] | 62.3 [61.0-63.8] |
| closed | 4 | pgmq.q_translate_vt_idx | 916 [888-960] | 61.8 [59.7-62.9] |
| closed | 8 | pgmq.q_acknowledge_vt_idx | 1800 [1664-1984] | 62.1 [61.7-64.3] |
| closed | 8 | pgmq.q_deliver_vt_idx | 1816 [1664-2008] | 62.9 [59.7-63.6] |
| closed | 8 | pgmq.q_translate_vt_idx | 1756 [1688-1992] | 61.5 [61.0-62.6] |
| soak | 8 | pgmq.q_acknowledge_vt_idx | 2112 | 63.6 |
| soak | 8 | pgmq.q_deliver_vt_idx | 2096 | 64.0 |
| soak | 8 | pgmq.q_translate_vt_idx | 2080 | 61.3 |

**In the 10-minute run** (8 workers, 281 thousand messages, sampled every 30 s):

- throughput is flat over the whole run (438 to 467 messages/s, p95 15 to 18 ms): no sign of
  degradation as the tables grow;
- the sizes of the queue tables **stop growing** after the first minute or two: all three queue
  heaps together stay between 4.6 and 5.8 MB, and their indexes at 6.4 MB from the first minute on;
- autovacuum visited each queue table about every 60 s (one-minute naptime): 30 passes on the
  queues in the run, each taking 30 ms at the median (at most 0.9 s) and removing 70 to 120
  tuples, which confirms that pruning does most of the work; `dead but not yet removable` never
  exceeded 9 on the queue tables, because nothing in the test holds a transaction open;
- `messages` was vacuumed 8 times (median 0.6 s, at most 1.5 s) and 98 % of its updates were HOT
  updates, with the default fillfactor of 100 and no index on `state`;
- the tables that only receive inserts (`transitions`, `archive_refs`, the pgmq archives) grow
  linearly, as expected: see the storage table.

Time series of the 10-minute run (8 workers):

| t (s) | messages/s | p95 ms | queue heaps KiB | queue indexes KiB | queue dead tuples (estimate) | queue autovacuums (total) | messages heap KiB | messages HOT updates / updates |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 46 | 467.0 | 15.2 | 3600 | 3896 | 126164 | 0 | 4504 | 62918 / 63082 |
| 76 | 466.1 | 15.6 | 5816 | 6408 | 2960 | 3 | 7440 | 104102 / 105099 |
| 106 | 449.6 | 16.0 | 5816 | 6408 | 84000 | 3 | 10280 | 144508 / 145618 |
| 136 | 445.1 | 16.2 | 5408 | 6408 | 110124 | 4 | 13104 | 183380 / 185731 |
| 166 | 461.0 | 15.8 | 4640 | 6408 | 83919 | 6 | 15968 | 224777 / 227255 |
| 196 | 460.1 | 15.8 | 4704 | 6408 | 2512 | 9 | 18800 | 264938 / 268736 |
| 226 | 465.3 | 15.4 | 4704 | 6408 | 86361 | 9 | 21744 | 306516 / 310660 |
| 256 | 464.0 | 15.6 | 4768 | 6408 | 2803 | 12 | 24560 | 346585 / 352466 |
| 286 | 448.7 | 16.1 | 4768 | 6408 | 83682 | 12 | 27408 | 386792 / 392906 |
| 316 | 438.4 | 16.6 | 4768 | 6408 | 884 | 15 | 30040 | 425154 / 432523 |
| 346 | 449.8 | 16.1 | 4768 | 6408 | 81755 | 15 | 32944 | 464700 / 472959 |
| 376 | 447.9 | 16.1 | 4768 | 6408 | 1875 | 18 | 35648 | 503574 / 513312 |
| 407 | 448.9 | 16.0 | 4768 | 6408 | 82789 | 18 | 38496 | 543292 / 553770 |
| 437 | 443.2 | 16.1 | 4928 | 6408 | 108181 | 19 | 41128 | 581912 / 593706 |
| 467 | 458.5 | 15.8 | 4960 | 6408 | 81858 | 21 | 44144 | 622151 / 635001 |
| 497 | 445.9 | 18.2 | 5216 | 6408 | 2790 | 24 | 47360 | 662133 / 675182 |
| 527 | 454.3 | 16.8 | 5216 | 6408 | 84654 | 24 | 50224 | 702970 / 716114 |
| 557 | 459.9 | 15.9 | 5216 | 6408 | 167604 | 24 | 52928 | 743406 / 757588 |
| 587 | 447.1 | 16.1 | 5456 | 6408 | 77541 | 27 | 55544 | 781902 / 798051 |
| 617 | 440.8 | 16.4 | 5328 | 6408 | 4867 | 30 | 58672 | 822247 / 838595 |

## Findings (exploratory, not decisions)

What the measurements suggest for this write pattern, this configuration and this machine. None
of it is a decision, and the fixture is not a schema proposal.

1. **SQL-only pgmq works** on the repository's PostgreSQL 18.6 image, as the entrypoint installs it,
   by hand as a superuser, and as a plain role without superuser rights. The queue API behaves as
   ADR 10 relies on (visibility timeout, redelivery after expiry, archive, delayed send).
   Managed PostgreSQL is not verified.
2. **Sustained throughput and latency** with stock settings and 4 ms of simulated external work
   per message: 74 / 232 / 435 messages per second with 1 / 4 / 8 workers (median of four runs;
   453 messages per second for 10 minutes at 8 workers), with a median end-to-end p95 of 12,
   16 and 19 ms in the closed loop and 23 to 56 ms in the open loop at 70 to 94 % of capacity.
   For scale: 100 messages per second is 8.6 million a day, 435 is 37 million. Single runs
   reached 890 (16 workers), 1,580 (32) and 1,925 (64 workers, no simulated work) messages per
   second; at 64 workers the host's CPUs were saturated, so that is the limit of this machine,
   not of PostgreSQL. The "millions of messages per day" of ADR 5 is consistent with what was
   measured, on this synthetic pattern.
3. **Commits are the main cost per message, not CPU**: 7 write commits per message wait for a WAL
   flush, about half of a worker's time at 1 worker; the test used 1.6 cores for 450 messages per
   second. Asynchronous commit (a what-if) gives 2.0 to 2.5 times the throughput with the same
   workers.
4. **Writes per message**: about 7.3 KB of WAL (8.1 KB with checkpoints), 13 transactions (7 that
   write), and 2.6 to 2.9 KB of heap plus indexes. A fifth of the WAL and 40 % of the disk space
   are the three pgmq archive tables, which keep every payload; the second-largest items are the
   five transition rows and the three sends. At 1 million messages a day that is about 2.8 GB
   of tables and 7 to 8 GB of WAL traffic a day.
5. **Queue bloat stayed bounded** over 10 minutes at 450 messages per second: the queue tables
   and their indexes stopped growing after the first minute (about 5 MB of heaps and 6.4 MB of
   indexes for the three queues), autovacuum passes on them took 30 ms at the median, and
   throughput and latency did not drift. Page pruning, not autovacuum, removed most dead tuples;
   the `n_dead_tup` estimate overstates the problem by orders of magnitude on these tables.
   `vt` index entries (every claim moves `vt`) make queue updates never HOT.
6. **`messages` updates were 98 % HOT** with the default fillfactor and no index on `state`. This
   depends on there being no index on a column that changes at every step.
7. **The closed loop wastes polls**: 6 of 9 `pgmq.read` calls per message found nothing, which is
   what a polling worker with no wake-up does. The closed-loop throughput is therefore a lower
   bound of what the pattern can do with a smarter wake-up.
8. **The host matters**: when other processes of the machine used 7 cores (run `closed-w8-r4`),
   8 workers dropped from about 445 to 378 messages per second and p95 rose from 16 to 25 ms.

## Limits of these measurements

- **One shared, noisy host.** The load average before the runs ranged from 0.8 to 9.9, and a
  stray 5 to 7 cores of other processes (test suites of other projects of the same machine) were
  seen at times. The first nine closed-loop runs recorded only the load average; the CPU
  accounting (`cores used by the test / by others` in the raw tables) was added afterwards and
  covers every later run, including a fourth repetition of the matrix. The run with 7.3 cores of
  other work is kept in the medians, not discarded. A first set of ceiling runs, taken while
  other processes saturated the host, was discarded and repeated.
- **A light client.** pgbench is lighter than a real service: no JSON handling, no HTTP, no
  connection pool, no application logic, no batching (every claim reads one job). Services will
  add CPU and round trips to each message.
- **A synthetic loop.** The closed loop saturates by construction and includes the polling waste
  described above; the open loop has no burst, no backlog above capacity, no failures.
- **Stock settings** (128 MB of `shared_buffers`, 1 GB `max_wal_size`, one-minute autovacuum
  naptime) and a database small enough to sit in the operating system cache (`shared_buffers`
  is 128 MB): 80-second runs reach about 100 MB, the 10-minute run about 700 MB. Nothing is known
  about hundreds of gigabytes.
- **Short runs.** 80 seconds for the matrix (autovacuum passed on each table once or twice), 10
  minutes for the soak. Slow effects (index growth over days, retention, wraparound) are out of
  reach.
- **Measurement slack.** Latencies are database-clock stamps (about a millisecond of slack at
  each end); counters of busy backends reach the shared statistics up to one second late;
  `pg_stat_statements` with `track = all` costs a little in every run.
- **Schema choices of the fixture shape the numbers**: two unique indexes on `messages` (the
  random content hash probably makes its index the largest; sizes were not measured per index),
  foreign keys, fillfactor 100, three
  queues, one claim per job.

## What could not be verified

- **Managed PostgreSQL** (RDS, Cloud SQL, Azure, Scaleway...): not available here. The plain-role
  install is only an approximation of its restrictions. Unknown: the SQL file on a given managed
  offer, available monitoring extensions (`pgstattuple`, `pg_stat_statements`), parameter
  limits, storage latency and IOPS credits, and above all commit latency with a Multi-AZ
  synchronous standby, which would add to the cost that dominates here.
- **High availability and replicas**: no replica, no failover, no WAL archiving or backup load, no
  replication lag.
- **Failure behaviour under load**: visibility-timeout expiry and redelivery are checked
  functionally only; no crashed worker, no dead-letter queue, no long transaction holding back
  vacuum, no `kill -9` of PostgreSQL.
- **Other pgmq features**: partitioned queues (they need `pg_partman`, so they are not part of
  the SQL-only install), `read_with_poll`, notifications, FIFO groups, `pgmq.read` with
  `qty` above 1.
- **Real services and workloads**: Node.js and Go drivers, a pooler (PgBouncer), real message
  sizes and bursts (an interchange of thousands of messages), per-partner ordering with advisory
  locks, row-level security for multi-tenancy.
- **Other machines**: ARM, local NVMe, spinning disks, a smaller instance.

## Questions for M3 design

Not answers: things this test makes worth deciding on purpose, each testable with the harness.

1. **Claim cost.** A claim is its own committed transaction, so 3 of the 7 write commits per
   message are claims. Are `read` with `qty` above 1, asynchronous commit for claims only (a lost
   claim means a redelivery, which at-least-once already allows), or fewer jobs per message
   acceptable?
2. **Granularity of jobs and states.** Which steps must be durable jobs (3 here) and which can
   run inline? Is one `messages` update per stage needed, or can the latest state be read from
   the insert-only `transitions`?
3. **Round trips.** Archive, send and the state change are about ten statements per stage.
   Would one SQL function per stage, or a pipeline, cut the time? (The 32 statements per message
   cost about 2.8 ms of the 13.6 ms of one worker, with their round trips.)
4. **Retention of archives and transitions.** pgmq archives keep every payload, and
   `transitions` grows by five rows per message. Time partitioning of our own tables, a job that
   deletes old rows, `pgmq.delete` instead of `pgmq.archive` (history already lives in
   `transitions`), or pgmq partitioned queues (which need `pg_partman`)?
5. **Duplicate detection.** The unique index on `(environment, partner, content hash)` has random
   keys, so it is probably the costliest index of `messages` (the three indexes of `messages` are
   larger than its heap; not measured per index). Does the content hash need its own unique
   index, or only an interchange key plus a check?
6. **Foreign keys.** Each child insert takes a row lock on the parent (7 per message, about 0.25 KB
   of WAL). Keep, or enforce in the transaction code?
7. **Polling and wake-up.** 6 of 9 reads were empty. What polling interval and backoff, or
   `LISTEN`/`NOTIFY`, or `read_with_poll`, balances idle cost against the latency added to
   an arriving message (up to the poll interval per stage)?
8. **Indexes on state.** A console that lists stuck or failed messages wants an index on
   `state`, which turns the HOT updates of `messages` into regular updates. Measure a partial
   index on non-final states, and a lower fillfactor.
9. **Autovacuum on queue tables.** The defaults kept the queues bounded at 450 messages per second
   because the naptime is short and pruning does the heavy work. What per-table settings for
   bursts, for a longer visibility timeout, and for a primary with a long-running reporting query
   (which holds back vacuum)?
10. **Target platform.** Re-run `smoke` and the matrix on the real managed PostgreSQL, with its
    storage and its standby, before fixing the number of workers per vCPU. Commit latency is the
    number that moves.
11. **Bursts.** An interchange with thousands of messages arrives at once: a batch insert and
    `send_batch` change the write pattern completely. Measure that path too.
12. **Per-partner ordering.** Where a flow needs it, an advisory lock or partition key per
    partner adds a lock round trip per claim; not measured.

## Raw data

The files in [`perf/pgmq/results`](../../perf/pgmq/results/) are the source of every number on
this page (`python3 -I perf/pgmq/summarize.py` rebuilds the tables). To keep the repository
small, `tables.csv` and `statements.csv` were trimmed to the closed-loop matrix and the long run,
and only two pgbench reports were kept; `run.sh` writes them all when it runs.

| File | Content |
| --- | --- |
| `runs.csv` | One row per run (26): throughput, latency percentiles, WAL and commits per message, autovacuum counts, load and CPU accounting |
| `tables.csv` | Per run of the matrix and the long run: every table and the queue indexes at the end (counters, `pgstattuple`, `pgstatindex`) |
| `statements.csv` | Most expensive statements of the first one-worker run and of the long run (`pg_stat_statements`) |
| `timeline.csv`, `autovacuum-soak-w8-r1.csv` | The 10-minute run sampled every 30 s, and each autovacuum pass of its database |
| `pgbench-closed-w1-r1.txt`, `pgbench-soak-w8-r1.txt` | pgbench's own report (per-statement latency) of the one-worker run and the long run |
| `smoke.txt`, `host.txt` | The install check; the host and PostgreSQL settings |
