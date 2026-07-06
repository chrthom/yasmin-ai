# Nightly Memory Processing — Deployment Checklist

**Status**: developer-actionable, manual ops steps only (no code changes required)
**Full design**: `nightly_memory_processing_implementation.md` (§2 one-time setup, §11 runbook, §13 rollout)
**Branch**: `feature/nightly-memory-processing`

This feature ships as **two separately-timed deployment units** on that branch — deploy Part A, run it in
production for a while, then only afterwards deploy Part B.

| Unit                              | Commits                                                                                                                         | Changes the live chat path?                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Part A — additive nightly job** | `feat(nightly-memory): M1` … `M4`, `fix(nightly-memory): M6 adversarial review fixes + docs update`                             | No. Adds new tables/files only; the live agent is untouched and keeps reading+writing `context_entries` exactly as before. |
| **Part B — read-only cutover**    | `feat(nightly-memory): M5 read-only cutover`, plus the `Session`/`Journal` data-cleanup commit that must merge together with it | Yes. Makes the live agent read-only for memory.                                                                            |

**Do not merge/deploy Part B until Part A's nightly job has run successfully in production for several
nights.** Part A alone is safe to merge and run indefinitely without Part B.

---

## Part A — Deploy the additive nightly job

### A1. Merge/deploy the Part A commits

Everything up to and including the M6 fix/docs commit — **not** the "read-only cutover" commit or the
data-cleanup commit that follows it.

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

### A9. Install the cron job

`scripts/nightly-memory-job.sh` is the wrapper (logs to `/var/log/yasmin-nightly.log`, emails
`christopher.thomsen@adesso.de` on non-zero exit). Add to `/etc/cron.d/yasmin-nightly`:

```
0 3 * * * christopher /home/christopher/Dokumente/yasmin-ai/scripts/nightly-memory-job.sh
```

Make sure the host's cron timezone (or an explicit `CRON_TZ=` line) matches `MEMORY_TZ`, and that
`/var/log/yasmin-nightly.log` is writable and outbound mail is configured.

### A10. Monitor for at least a week

```sql
SELECT id, started_at, completed_at, status, last_completed_phase, error_message
FROM nightly_job_log ORDER BY id DESC LIMIT 14;
```

Expect `status = 'completed'` most nights. A `'partial'` status is not an emergency — read
`error_message`/the log, it's typically a single skipped conversation or a transient upload failure that
will self-heal next night — but investigate a `'failed'` status or repeated `'partial'`s before proceeding
to Part B. See the implementation doc's §11 runbook for troubleshooting specific symptoms.

---

## Part B — Deploy the read-only cutover (only after Part A is verified)

### B1. Merge the two remaining branch commits together, as one unit

- `feat(nightly-memory): M5 read-only cutover` (`chat_agent.ts`, `context.service.ts`,
  `mistral_config/system_prompt.txt`, deletes `mistral_config/functions/update_context_entry.json`)
- The follow-up data-cleanup commit (`db_proxy.ts`, `database/schema.sql`, `CONTEXT_CONVENTIONS.md`)

Do not deploy the data-cleanup commit ahead of the code commit — see `CONTEXT_CONVENTIONS.md` §2.1 for
exactly why (a stale `update_context_entry` write attempt against an already-removed `Session with X` row
would silently no-op, which only becomes correct behavior once the code no longer tries).

### B2. Mistral Console

On the **live conversation agent** (not the nightly one), remove its `update_context_entry` function
registration and update its system prompt to the new `mistral_config/system_prompt.txt` content. If you
didn't already do it in step A3, attach the `memory` library now.

### B3. (Optional) Purge stale rows from the already-running production database

The updated `schema.sql` only affects _fresh_ installs, it won't retroactively delete existing rows:

```sql
DELETE FROM context_entries WHERE title LIKE 'Session with %' OR title LIKE 'Journal with %';
```

Harmless to skip — those rows just sit there empty and unused either way.

### B4. Deploy the code

Have a real conversation afterward and confirm: profile/family-notes context still loads correctly on turn
1, and the agent no longer attempts (or is able) to write memory.

### B5. Keep monitoring

`nightly_job_log` remains the sole writer of `context_entries` from this point on.

---

## Rollback

See `nightly_memory_processing_implementation.md` §11 for the full runbook (stale lock recovery, restoring
a prior `memory_archive` version, re-running a partial/failed job, etc.). Both parts above are additive/
reversible at the code level; reverting Part B alone (redeploying the pre-cutover `chat_agent.ts` /
`context.service.ts` / `system_prompt.txt`) restores live write access without touching the nightly job.

## Further reading

- `nightly_memory_processing_implementation.md` — full implementation design, DDL, phase-by-phase pipeline
  behavior, privacy model, test plan.
- `nightly_memory_processing_concept_v3.md` — the original architecture concept this implementation is
  based on (two-store model: Mistral verbose long-term + MariaDB eager cache).
