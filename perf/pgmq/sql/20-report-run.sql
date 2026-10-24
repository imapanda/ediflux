-- One CSV row per run. psql variables: run_id, mode, workers, rep, rate (offered msg/s, or
-- empty for a closed loop). Needs the snapshots "start", "w0" (start of the measurement
-- window), "w1" (end of the window) and "end" (after the load has stopped).
--
-- Latency of a message = completed_at - received_at, both read from the database clock:
-- from the start of the intake transaction to the commit-time stamp of the last transition.
-- Only messages completed inside the window count, so warm-up and cool-down are excluded.
\set ON_ERROR_STOP on
copy (
  with s as (
    select (select ts from perf.snap_global where label = 'w0') as t0,
           (select ts from perf.snap_global where label = 'w1') as t1
  ),
  done as (
    select m.received_at, m.completed_at,
           extract(epoch from (m.completed_at - m.received_at)) * 1000 as lat_ms
    from fixture.messages m, s
    where m.completed_at > s.t0 and m.completed_at <= s.t1
  ),
  q as (
    select percentile_cont(array[0.5, 0.95, 0.99]) within group (order by lat_ms) as p,
           max(lat_ms) as max_ms, count(*) as n
    from done
  ),
  ingested as (
    select count(*) as n from fixture.messages m, s
    where m.received_at > s.t0 and m.received_at <= s.t1
  ),
  tot as (
    select count(*) as ingested, count(completed_at) as completed from fixture.messages
  ),
  redelivered as (
    select (select count(*) from pgmq.a_translate where read_ct > 1)
         + (select count(*) from pgmq.a_deliver where read_ct > 1)
         + (select count(*) from pgmq.a_acknowledge where read_ct > 1) as n
  ),
  g as (
    select (e.wal_bytes - b.wal_bytes) as wal_bytes,
           (e.wal_records - b.wal_records) as wal_records,
           (e.wal_fpi - b.wal_fpi) as wal_fpi,
           (e.xact_commit - b.xact_commit) as commits,
           (e.checkpoints_timed - b.checkpoints_timed) + (e.checkpoints_req - b.checkpoints_req) as checkpoints
    from perf.snap_global e, perf.snap_global b
    where e.label = 'end' and b.label = 'start'
  ),
  av as (
    select sum(autovacuum_count) as vac, sum(autoanalyze_count) as ana
    from perf.snap_tables where label = 'end'
  )
  select :'run_id' as run_id,
         :'mode' as mode,
         :workers as workers,
         :rep as rep,
         nullif(:'rate', '') as offered_msg_s,
         round(extract(epoch from (s.t1 - s.t0))::numeric, 1) as window_s,
         q.n as completed_in_window,
         round((q.n / extract(epoch from (s.t1 - s.t0)))::numeric, 1) as msg_s,
         round((ingested.n / extract(epoch from (s.t1 - s.t0)))::numeric, 1) as intake_msg_s,
         round(q.p[1]::numeric, 1) as p50_ms,
         round(q.p[2]::numeric, 1) as p95_ms,
         round(q.p[3]::numeric, 1) as p99_ms,
         round(q.max_ms::numeric, 1) as max_ms,
         tot.ingested - tot.completed as in_flight_at_end,
         tot.completed as completed_total,
         redelivered.n as redelivered_jobs,
         round((g.wal_bytes / tot.completed)::numeric, 0) as wal_bytes_per_msg,
         round((g.wal_records::numeric / tot.completed), 1) as wal_records_per_msg,
         round((g.wal_fpi::numeric / tot.completed), 2) as wal_fpi_per_msg,
         round((g.commits::numeric / tot.completed), 1) as commits_per_msg,
         g.checkpoints as checkpoints,
         av.vac as autovacuums,
         av.ana as autoanalyzes
  from s, q, ingested, tot, redelivered, g, av
) to stdout with csv
