-- One CSV row per table (and per index of the queue tables) at the end of a run, before any
-- manual VACUUM. Counters come from pg_stat_user_tables (cumulative since the database was
-- created, that is for the run); the exact bloat figures come from pgstattuple / pgstatindex.
-- psql variable: run_id.
\set ON_ERROR_STOP on
copy (
  select :'run_id' as run_id, 'table' as kind, e.relname as name,
         e.n_tup_ins, e.n_tup_upd, e.n_tup_del, e.n_tup_hot_upd, e.n_dead_tup as n_dead_tup_stat,
         e.autovacuum_count, e.heap_bytes, e.index_bytes,
         p.tuple_count, p.dead_tuple_count,
         round(p.dead_tuple_percent::numeric, 1) as dead_pct,
         round(p.free_percent::numeric, 1) as free_pct,
         null::numeric as leaf_density_pct
  from perf.snap_tables e, lateral pgstattuple(e.relname::regclass) p
  where e.label = 'end'
  union all
  select :'run_id', 'index', i.indexrelid::regclass::text,
         null, null, null, null, null, null,
         x.index_size, null, null, null, null, null,
         round(x.avg_leaf_density::numeric, 1)
  from pg_index i
  join pg_class t on t.oid = i.indrelid
  join pg_namespace n on n.oid = t.relnamespace
  cross join lateral pgstatindex(i.indexrelid) x
  where n.nspname = 'pgmq' and t.relname like 'q\_%'
  order by 2, 3
) to stdout with csv
