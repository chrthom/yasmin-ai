# Nightly Memory Processing — Deployment Checklist

**Status**: developer-actionable, manual ops steps + a small follow-up commit (in-process scheduler
replacing the cron wrapper, see A9)
**Full design**: `nightly_memory_processing_implementation.md` (§2 one-time setup, §11 runbook, §13 rollout)
**Branch**: `feature/nightly-memory-part-a`

This feature ships as **two separately-timed PRs** — this one (Part A, additive nightly job) and a
follow-up PR (Part B, read-only cutover) opened only after Part A has run cleanly in production for a
while. Part A alone is safe to merge and run indefinitely without Part B; it does not touch the live chat
path (the live agent keeps reading+writing `context_entries` exactly as before, untouched by this PR).

---

## Part A — Deploy the additive nightly job

### A1. Merge/deploy this PR

Additive only: new tables/files, plus an in-process scheduler that starts alongside the existing API
server. Nothing in the live conversation agent's request/response path changes.

### A2. Apply the new schema

Non-destructive; does not touch `context_entries`.

```
mysql -h 192.168.0.2 -P 3307 -u yasmin -p yasmin < database/schema_memory.sql
```

Creates `memory_archive`, `nightly_job_log`, `processing_lock`.

### A3. Mistral Console setup

- Confirm/obtain the production **`memory` library id** → this is `MISTRAL_LIBRARY_ID`.
- Attach the `memory` library to the existing live conversation agent for RAG. Safe to do now — the current
  (pre-cutover) system prompt doesn't reference it, so it's inert until Part B.
- Create a new agent named **`yasmin-nightly`**, with the system prompt from
  `mistral_config/nightly_system_prompt.txt`, and register its 4 function-calling tools from
  `mistral_config/functions/{list_long_term_files,get_long_term_file,read_todays_journals,stage_update}.json`.
  Library wiring for this agent is optional (only useful for cross-file discovery during integration — the
  pipeline reads full files from `memory_archive` directly, not via RAG). Note its agent id →
  `AGENT_ID_NIGHTLY`.
- Issue a **production API key** with access to the library and both agents. Verify it can
  `GET /v1/libraries/{MISTRAL_LIBRARY_ID}` before continuing.

### A4. Set environment variables

`MISTRAL_LIBRARY_ID`, `AGENT_ID_NIGHTLY`, optionally `MEMORY_TZ` (default `Europe/Berlin`) and
`NIGHTLY_MAX_RETRIES` (default `3`).

**This is not optional for Part A.** The nightly scheduler now runs in-process inside the main API
server (`src/nightly/scheduler.ts`, started from `app.ts`) — `validateEnv()` requires
`MISTRAL_LIBRARY_ID` and `AGENT_ID_NIGHTLY` unconditionally, so the server itself refuses to start
without them, not just the standalone nightly script. Set these on the container the app runs in
(e.g. `docker run -e MISTRAL_LIBRARY_ID=... -e AGENT_ID_NIGHTLY=...`, or the `environment:` block of a
compose file) before starting/restarting it in step A9.

### A5. Build

```
npm run build
```

Produces `dist/nightly/run.js`.

### A6. Bootstrap — run exactly once, before the first real nightly run

```
npm run bootstrap-memory
```

Reads the _existing_ `context_entries` rows and seeds `memory_archive` + the Mistral library from them.
**This step is critical**: skipping it means the verbose store starts empty, and the nightly job's
eager-cache regeneration would otherwise wipe the live profiles on its first run. (In practice this can't
happen silently — the pipeline's eager-cache phase only ever _upserts_ titles that have a verbose source, so
a missed bootstrap degrades to "no change," not data loss — but don't rely on that safety net; just run this
step.) Safe to re-run: hash-based no-churn means a repeat run uploads nothing new.

### A7. Dry run

Checks DB + Mistral connectivity, logs what a real run would see, writes nothing.

```
npm run nightly:dry-run
```

### A8. One real manual run

```
npm run nightly
```

Inspect the log and the `nightly_job_log` table afterward. Confirm: journals were created for any recent
conversations, `memory_archive` has new/unchanged versions as expected, `context_entries` was regenerated
(spot-check a `Profile of X` row), and the job's `nightly_job_log` row has `status = 'completed'`.

### A9. Start/restart the app

No cron job to install. The nightly run is scheduled in-process by `src/nightly/scheduler.ts`, started
automatically from `app.ts` alongside the API server (`npm start` / the container's normal entrypoint) —
restarting the container after step A4's env vars are set is enough. It computes the next 23:00 (or
whatever `MEMORY_TZ` resolves to) on its own and logs `INFO Nightly scheduler started ...` on boot; check
`docker logs` (or wherever the container's stdout goes) for that line to confirm it's armed.

### A10. Monitor, then open the Part B PR

```sql
SELECT id, started_at, completed_at, status, last_completed_phase, error_message
FROM nightly_job_log ORDER BY id DESC LIMIT 14;
```

Expect `status = 'completed'` most nights. A `'partial'` status is not an emergency — read
`error_message`/the log, it's typically a single skipped conversation or a transient upload failure that
will self-heal next night — but investigate a `'failed'` status or repeated `'partial'`s before opening the
Part B PR. See the implementation doc's §11 runbook for troubleshooting specific symptoms.

Once you're confident, open the Part B PR (branch based on top of this one) — it makes the live agent
read-only for memory and retires the old `Session`/`Journal` entries. See that PR's own deployment
checklist for its rollout steps.

---

## Rollback

See `nightly_memory_processing_implementation.md` §11 for the full runbook (stale lock recovery, restoring
a prior `memory_archive` version, re-running a partial/failed job, etc.). Part A is additive/reversible at
the code level — reverting this PR alone restores the pre-nightly-job state; the live agent's read/write
path is never touched by it.

## Further reading

- `nightly_memory_processing_implementation.md` — full implementation design, DDL, phase-by-phase pipeline
  behavior, privacy model, test plan.
- `nightly_memory_processing_concept_v3.md` — the original architecture concept this implementation is
  based on (two-store model: Mistral verbose long-term + MariaDB eager cache).
