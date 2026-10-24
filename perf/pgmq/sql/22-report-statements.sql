-- The most expensive statements of a run, from pg_stat_statements (track = all, so the SQL
-- that pgmq's plpgsql functions run internally is listed too). psql variable: run_id.
\set ON_ERROR_STOP on
copy (
  select :'run_id' as run_id, s.calls, round(s.total_exec_time::numeric, 0) as total_ms,
         round(s.mean_exec_time::numeric, 3) as mean_ms, s.rows, s.wal_records, s.wal_bytes,
         rtrim(left(regexp_replace(s.query, '\s+', ' ', 'g'), 100)) as query
  from pg_stat_statements s
  where s.dbid = (select oid from pg_database where datname = current_database())
  order by s.total_exec_time desc
  limit 16
) to stdout with csv
