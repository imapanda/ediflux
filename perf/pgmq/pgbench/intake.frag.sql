-- Intake: what the api does when a gateway hands over a file. One transaction: the message
-- row (duplicate detection by unique keys), the reference to the archived raw file, and the
-- "translate" job. Included by worker.sql and producer.sql (see bench.sh).
\set partner random(1, 50)
\set size random(800, 16000)
BEGIN;
INSERT INTO fixture.messages (environment, partner_id, interchange_sender, interchange_recipient, interchange_ref, content_hash, size_bytes, state, config_version)
VALUES ('production', :partner::int, 'PARTNER' || :partner::int, 'LIBREDI', nextval('fixture.interchange_seq'), encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), :size::int, 'received', :cv::int)
ON CONFLICT DO NOTHING
RETURNING id, content_hash \gset m_
INSERT INTO fixture.archive_refs (message_id, kind, sha256, size_bytes) VALUES (:m_id::bigint, 'raw', :m_content_hash::text, :size::int);
SELECT pgmq.send('translate', jsonb_build_object('type', 'translate', 'version', 1, 'message_id', :m_id::bigint, 'environment', 'production', 'raw_sha256', :m_content_hash::text, 'traceparent', '00-' || replace(gen_random_uuid()::text, '-', '') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16) || '-01'));
COMMIT;
