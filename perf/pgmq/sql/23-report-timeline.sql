-- Time series of a long run: one CSV row per sampling snapshot (labels s001, s002, ...).
-- Throughput and p95 latency are those of the messages completed since the previous snapshot;
-- the other columns are read from pg_stat_user_tables at the snapshot. psql variable: run_id.
\set ON_ERROR_STOP on
copy (
  with g as (
    select label, ts, lag(ts) over (order by ts) as prev_ts from perf.snap_global
  ),
  per as (
    select g.label, g.ts, g.prev_ts,
           (select count(*) from fixture.messages m
             where m.completed_at > g.prev_ts and m.completed_at <= g.ts) as done,
           (select percentile_cont(0.95) within group
                     (order by extract(epoch from m.completed_at - m.received_at) * 1000)
              from fixture.messages m
             where m.completed_at > g.prev_ts and m.completed_at <= g.ts) as p95
    from g
  )
  select :'run_id' as run_id, p.label,
         round(extract(epoch from (p.ts - (select ts from perf.snap_global where label = 'start')))::numeric, 0) as t_s,
         round((p.done / extract(epoch from (p.ts - p.prev_ts)))::numeric, 1) as msg_s,
         round(p.p95::numeric, 1) as p95_ms,
         q.heap_bytes as queue_heap_bytes,
         q.index_bytes as queue_index_bytes,
         q.n_dead_tup as queue_dead_tup,
         q.autovacuum_count as queue_autovacuums,
         m.heap_bytes as messages_heap_bytes,
         m.n_dead_tup as messages_dead_tup,
         m.n_tup_hot_upd as messages_hot_upd,
         m.n_tup_upd as messages_upd
  from per p
  cross join lateral (
    select sum(heap_bytes) as heap_bytes, sum(index_bytes) as index_bytes,
           sum(n_dead_tup) as n_dead_tup, sum(autovacuum_count) as autovacuum_count
    from perf.snap_tables t where t.label = p.label and t.relname like 'pgmq.q\_%'
  ) q
  cross join lateral (
    select heap_bytes, n_dead_tup, n_tup_hot_upd, n_tup_upd
    from perf.snap_tables t where t.label = p.label and t.relname = 'fixture.messages'
  ) m
  where p.label ~ '^s[0-9]+$'
  order by p.ts
) to stdout with csv
