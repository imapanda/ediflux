-- Acceptance check: pgmq installed from its SQL file works through its SQL API. Run, after
-- pgmq.sql, by "run.sh smoke", as a superuser and as a plain role without any privilege.
\set ON_ERROR_STOP on

select current_user as role,
       (select rolsuper from pg_roles where rolname = current_user) as superuser,
       (select count(*) from pg_extension where extname = 'pgmq') as pgmq_extensions,
       (select count(*) from pg_available_extensions where name = 'pgmq') as pgmq_available_as_extension;

select pgmq.create('smoke');
select pgmq.send('smoke', '{"hello": "world"}'::jsonb) as msg_id;

do $$
declare
  m pgmq.message_record;
  n integer;
begin
  -- read with a visibility timeout: the message is returned, then invisible while leased
  select * into m from pgmq.read('smoke', 30, 1);
  assert m.message ->> 'hello' = 'world', 'the message read is not the message sent';
  assert m.read_ct = 1, 'read_ct should be 1';
  select count(*) into n from pgmq.read('smoke', 30, 1);
  assert n = 0, 'a leased message must not be visible to another consumer';
  -- archive moves it to the archive table
  assert pgmq.archive('smoke', m.msg_id), 'archive should return true';
  select count(*) into n from pgmq.a_smoke;
  assert n = 1, 'the archived message should be in a_smoke';
  select count(*) into n from pgmq.q_smoke;
  assert n = 0, 'the queue should be empty after the archive';

  -- a lease that expires makes the message visible again, with read_ct = 2
  perform pgmq.send('smoke', '{"retry": true}'::jsonb);
  select * into m from pgmq.read('smoke', 1, 1);
  perform pg_sleep(1.2);
  select * into m from pgmq.read('smoke', 30, 1);
  assert m.read_ct = 2, 'an expired lease should redeliver the message with read_ct = 2';
  assert pgmq.delete('smoke', m.msg_id), 'delete should return true';

  -- delayed send: invisible until the delay has passed
  perform pgmq.send('smoke', '{"later": true}'::jsonb, 1);
  select count(*) into n from pgmq.read('smoke', 30, 1);
  assert n = 0, 'a delayed message must not be visible before its delay';
  perform pg_sleep(1.2);
  select count(*) into n from pgmq.read('smoke', 30, 1);
  assert n = 1, 'a delayed message must be visible after its delay';

  -- batch send and batch read (the delayed message above is still leased, so 2 are visible)
  perform pgmq.send_batch('smoke', array['{"i": 1}', '{"i": 2}']::jsonb[]);
  select count(*) into n from pgmq.read('smoke', 30, 10);
  assert n = 2, 'both batch messages should be read once';
end $$;

select queue_name, queue_length, total_messages from pgmq.metrics('smoke');
select pgmq.drop_queue('smoke');
select 'OK: pgmq SQL install works' as result;
