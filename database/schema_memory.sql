-- Additive, non-destructive schema for nightly memory processing (M1).
-- Does not touch database/schema.sql or the existing context_entries table.
-- Apply via: mysql -h 192.168.0.2 -P 3307 -u yasmin -p yasmin < database/schema_memory.sql

-- Full verbose, versioned copy of every long-term memory file; durable source + backup.
CREATE TABLE IF NOT EXISTS memory_archive (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    file_path      VARCHAR(255) NOT NULL,      -- e.g. people/christopher.md
    content        MEDIUMTEXT   NOT NULL,      -- full verbose content (may include [PRIVACY:SENSITIVE])
    content_hash   CHAR(64)     NOT NULL,      -- SHA-256 of content
    version        INT          NOT NULL,      -- monotonic per file_path; MAX = current
    mistral_doc_id VARCHAR(64)  NULL,          -- Mistral document id of the uploaded copy
    synced_at      TIMESTAMP    NULL,          -- set when this version was confirmed uploaded
    created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    -- Current version of a file = row with MAX(version) for that file_path
    UNIQUE KEY uk_path_version (file_path, version),
    INDEX idx_path (file_path),
    INDEX idx_unsynced (file_path, synced_at)
);

CREATE TABLE IF NOT EXISTS nightly_job_log (
    id                         INT AUTO_INCREMENT PRIMARY KEY,
    started_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at               TIMESTAMP NULL,
    status                     ENUM('running', 'completed', 'partial', 'failed') NOT NULL DEFAULT 'running',
    last_completed_phase       VARCHAR(32) NULL,
    processed_conversation_ids JSON NULL,
    skipped_conversation_ids   JSON NULL,      -- conversations that failed a phase and were skipped
    retry_count                INT DEFAULT 0,
    error_message              TEXT NULL,
    conversations_processed    INT DEFAULT 0,
    files_updated              INT DEFAULT 0,
    files_created              INT DEFAULT 0,
    INDEX idx_status_completed (status, completed_at)
);

CREATE TABLE IF NOT EXISTS processing_lock (
    lock_name   VARCHAR(64) PRIMARY KEY,       -- e.g. 'nightly'
    acquired_at TIMESTAMP NOT NULL,
    owner       VARCHAR(128) NOT NULL          -- host:pid
);

-- Durable, single-row watermark of the most recent successful snapshot the job has fully processed.
-- Deliberately kept OUT of nightly_job_log (which pruneOldJobLogs deletes from): if every completed
-- row were ever pruned, getWatermark() would return NULL and the next run would silently reprocess
-- the previous 24h. This table is never pruned.
CREATE TABLE IF NOT EXISTS nightly_watermark (
    id          TINYINT PRIMARY KEY,           -- singleton; always 1
    snapshot_at DATETIME NOT NULL              -- Phase-1 listing snapshot time of the last fully-completed run
);
