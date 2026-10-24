-- A competing consumer. One execution of this script is one polling iteration:
--
--   1. claim the next job, trying the last stage first so that messages in flight drain
--      before new ones enter: acknowledge, then deliver, then translate;
--   2. do the work: the external call (translator, ERP folder) is simulated by a sleep that
--      holds no transaction, then one transaction records the state change, the transitions,
--      the archive reference, archives the job and sends the next one;
--   3. if no queue has a job: either take in a new message (:idle_intake = 1, closed loop,
--      the same clients play the api and the workers) or sleep (:idle_intake = 0, a separate
--      producer feeds the queues).
--
-- Each pgmq.read is wrapped in an aggregate so that it always returns exactly one row, which
-- is what pgbench's \gset needs; job = 0 means "queue empty". The visibility timeout is :vt
-- seconds. Parameters: -D vt= translate_ms= deliver_ms= idle_intake= idle_ms=.
\set cv random(1, 3)

SELECT coalesce(max(msg_id), 0) AS job, coalesce(max((message ->> 'message_id')::bigint), 0) AS mid FROM pgmq.read('acknowledge', :vt::int, 1) \gset a_
\if :a_job > 0
  -- Job 3: the acknowledgement. Last transition; the message is complete.
  BEGIN;
  UPDATE fixture.messages SET state = 'acknowledged', updated_at = clock_timestamp(), completed_at = clock_timestamp() WHERE id = :a_mid::bigint;
  INSERT INTO fixture.transitions (message_id, from_state, to_state, component, config_version) VALUES (:a_mid::bigint, 'delivered', 'acknowledged', 'worker', :cv::int);
  SELECT pgmq.archive('acknowledge', :a_job::bigint);
  COMMIT;
\else
  SELECT coalesce(max(msg_id), 0) AS job, coalesce(max((message ->> 'message_id')::bigint), 0) AS mid FROM pgmq.read('deliver', :vt::int, 1) \gset d_
  \if :d_job > 0
    -- Job 2: the delivery. Simulated write to the destination, then one transition.
    \sleep :deliver_ms ms
    BEGIN;
    UPDATE fixture.messages SET state = 'delivered', updated_at = clock_timestamp() WHERE id = :d_mid::bigint;
    INSERT INTO fixture.transitions (message_id, from_state, to_state, component, config_version) VALUES (:d_mid::bigint, 'mapped', 'delivered', 'worker', :cv::int);
    SELECT pgmq.archive('deliver', :d_job::bigint);
    SELECT pgmq.send('acknowledge', jsonb_build_object('type', 'acknowledge', 'version', 1, 'message_id', :d_mid::bigint, 'environment', 'production', 'traceparent', '00-' || replace(gen_random_uuid()::text, '-', '') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16) || '-01'));
    COMMIT;
  \else
    SELECT coalesce(max(msg_id), 0) AS job, coalesce(max((message ->> 'message_id')::bigint), 0) AS mid FROM pgmq.read('translate', :vt::int, 1) \gset t_
    \if :t_job > 0
      -- Job 1: the translation. Simulated call to the translator, then three transitions
      -- (parsed, validated, mapped), the reference to the rendered output, the next job.
      \sleep :translate_ms ms
      BEGIN;
      UPDATE fixture.messages SET state = 'mapped', updated_at = clock_timestamp() WHERE id = :t_mid::bigint;
      INSERT INTO fixture.transitions (message_id, from_state, to_state, component, config_version) VALUES (:t_mid::bigint, 'received', 'parsed', 'worker', :cv::int), (:t_mid::bigint, 'parsed', 'validated', 'worker', :cv::int), (:t_mid::bigint, 'validated', 'mapped', 'worker', :cv::int);
      INSERT INTO fixture.archive_refs (message_id, kind, sha256, size_bytes) VALUES (:t_mid::bigint, 'rendered', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 2048) RETURNING sha256 \gset r_
      SELECT pgmq.archive('translate', :t_job::bigint);
      SELECT pgmq.send('deliver', jsonb_build_object('type', 'deliver', 'version', 1, 'message_id', :t_mid::bigint, 'environment', 'production', 'rendered_sha256', :r_sha256::text, 'traceparent', '00-' || replace(gen_random_uuid()::text, '-', '') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16) || '-01'));
      COMMIT;
    \else
      \if :idle_intake = 1
-- @@INTAKE@@
      \else
        \sleep :idle_ms ms
      \endif
    \endif
  \endif
\endif
