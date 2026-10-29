-- One-time migration: convert existing tables to utf8mb4 so 4-byte UTF-8 sequences
-- (emojis like U+1F60F) can be stored. The connection already uses utf8mb4
-- (src/database/connection.ts), but tables created from the original schema files
-- inherited the server's default charset (utf8mb3), which rejects 4-byte characters
-- with ER_TRUNCATED_WRONG_VALUE_FOR_FIELD / errno 1366.
-- Apply via: mysql -h <host> -P <port> -u yasmin -p yasmin < database/migrate_utf8mb4.sql
-- Safe to re-run: converting to the charset a table already has is a no-op.

ALTER TABLE context_entries CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE intraday_notes CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE memory_archive CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE nightly_job_log CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE processing_lock CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE nightly_watermark CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
