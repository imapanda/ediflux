-- TEST FIXTURE FOR THE LOAD TEST. NOT A MIGRATION, NOT A SCHEMA PROPOSAL.
--
-- There is no real schema yet (milestone 3 designs it). This file is a deliberately plain
-- stand-in that only has to produce a realistic *write pattern* per message, modelled on
-- docs/architecture.md (message lifecycle, reliability model) and ADR 5 and 10:
--
--   - a message row with the duplicate-detection keys (environment, partner, interchange
--     sender, recipient and control reference; and the content hash);
--   - one row per state transition (Received > Parsed > Validated > Mapped > Delivered >
--     Acknowledged: 5 transitions);
--   - references to the archived files (claim check), not the files themselves;
--   - three pgmq jobs per message (translate, deliver, acknowledge).
--
-- Choices here (types, indexes, foreign keys, fillfactor) are guesses to be measured, not
-- decisions. Run with psql -v ff=<messages fillfactor, 100 = default> after pgmq.sql.

create schema fixture;

create sequence fixture.interchange_seq;

create table fixture.messages (
  id bigint generated always as identity primary key,
  environment text not null,
  partner_id integer not null,
  interchange_sender text not null,
  interchange_recipient text not null,
  interchange_ref bigint not null,
  content_hash text not null,
  size_bytes integer not null,
  state text not null,
  config_version integer not null,
  received_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  -- Duplicate detection (ADR 5): the interchange key, and the content hash.
  unique (environment, partner_id, interchange_sender, interchange_recipient, interchange_ref),
  unique (environment, partner_id, content_hash)
) with (fillfactor = :ff);

create table fixture.transitions (
  id bigint generated always as identity primary key,
  message_id bigint not null references fixture.messages (id),
  from_state text not null,
  to_state text not null,
  component text not null,
  config_version integer not null,
  at timestamptz not null default clock_timestamp()
);
create index on fixture.transitions (message_id);

create table fixture.archive_refs (
  message_id bigint not null references fixture.messages (id),
  kind text not null,
  sha256 text not null,
  size_bytes integer not null,
  stored_at timestamptz not null default clock_timestamp(),
  primary key (message_id, kind)
);

-- The queues of the reliable core (ADR 10, section 3).
select pgmq.create('translate');
select pgmq.create('deliver');
select pgmq.create('acknowledge');

-- Measurement tooling (not part of the fixture's write pattern): exact bloat figures.
create extension pgstattuple;
create extension pg_stat_statements;

create schema perf;

create table perf.snap_global (
  label text primary key,
  ts timestamptz not null,
  wal_records bigint,
  wal_fpi bigint,
  wal_bytes numeric,
  xact_commit bigint,
  checkpoints_timed bigint,
  checkpoints_req bigint,
  buffers_written bigint
);

create table perf.snap_tables (
  label text not null,
  ts timestamptz not null,
  relname text not null,
  n_live_tup bigint,
  n_dead_tup bigint,
  n_tup_ins bigint,
  n_tup_upd bigint,
  n_tup_del bigint,
  n_tup_hot_upd bigint,
  vacuum_count bigint,
  autovacuum_count bigint,
  autoanalyze_count bigint,
  heap_bytes bigint,
  index_bytes bigint,
  primary key (label, relname)
);

-- Counters since the start of the database, so the difference of two snapshots is the cost of
-- what ran between them. Statistics of busy backends reach the shared counters with a delay of
-- up to about one second, so the "end" snapshot is taken after the load has stopped.
create function perf.snap(p_label text) returns void language plpgsql as $$
begin
  perform pg_stat_force_next_flush();
  insert into perf.snap_global
  select p_label, clock_timestamp(), w.wal_records, w.wal_fpi, w.wal_bytes,
         d.xact_commit, c.num_timed, c.num_requested, c.buffers_written
  from pg_stat_wal w, pg_stat_checkpointer c, pg_stat_database d
  where d.datname = current_database();
  insert into perf.snap_tables
  select p_label, clock_timestamp(), s.schemaname || '.' || s.relname,
         s.n_live_tup, s.n_dead_tup, s.n_tup_ins, s.n_tup_upd, s.n_tup_del, s.n_tup_hot_upd,
         s.vacuum_count, s.autovacuum_count, s.autoanalyze_count,
         pg_relation_size(s.relid), pg_indexes_size(s.relid)
  from pg_stat_user_tables s
  where s.schemaname in ('pgmq', 'fixture');
end $$;
