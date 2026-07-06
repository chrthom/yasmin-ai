# Nightly Memory Processing — Deployment Checklist (Part B)

**Status**: developer-actionable, manual ops steps only (no code changes required)
**Full design**: `nightly_memory_processing_implementation.md` (§2 one-time setup, §11 runbook, §13 rollout)
**Branch**: `feature/nightly-memory-part-b`
**Prerequisite**: the Part A PR (`feature/nightly-memory-part-a`) is merged and its nightly job has run
cleanly in production for a while — see that PR's own `docs/deployment_checklist.md` for the A1-A10 steps.
Do not merge/deploy this PR before that.

This PR makes the live conversation agent **read-only for memory**: the nightly job (already running from
Part A) becomes the sole writer of `context_entries`, and the old `Session with X` / `Journal with X`
entries are retired for good.

---

## B1. Merge/deploy this PR

This PR's two commits must land together, not staggered:

- The read-only cutover itself (`chat_agent.ts`, `context.service.ts`, `mistral_config/system_prompt.txt`,
  deletes `mistral_config/functions/update_context_entry.json`).
- The `Session`/`Journal` data-cleanup commit (`db_proxy.ts`, `database/schema.sql`,
  `CONTEXT_CONVENTIONS.md`).

Do not deploy the data-cleanup commit ahead of the code commit — see `CONTEXT_CONVENTIONS.md` §2.1 for
exactly why (a stale `update_context_entry` write attempt against an already-removed `Session with X` row
would silently no-op, which only becomes correct behavior once the code no longer tries).

## B2. Mistral Console

On the **live conversation agent** (not the nightly one), remove its `update_context_entry` function
registration and update its system prompt to the new `mistral_config/system_prompt.txt` content. If you
didn't already do it during Part A, attach the `memory` library now.

## B3. (Optional) Purge stale rows from the already-running production database

The updated `schema.sql` only affects _fresh_ installs, it won't retroactively delete existing rows:

```sql
DELETE FROM context_entries WHERE title LIKE 'Session with %' OR title LIKE 'Journal with %';
```

Harmless to skip — those rows just sit there empty and unused either way.

## B4. Deploy the code

Have a real conversation afterward and confirm: profile/family-notes context still loads correctly on turn
1, and the agent no longer attempts (or is able) to write memory.

## B5. Keep monitoring

`nightly_job_log` remains the sole writer of `context_entries` from this point on.

---

## Rollback

See `nightly_memory_processing_implementation.md` §11 for the full runbook (stale lock recovery, restoring
a prior `memory_archive` version, re-running a partial/failed job, etc.). Reverting this PR alone
(redeploying the pre-cutover `chat_agent.ts` / `context.service.ts` / `system_prompt.txt`) restores live
write access without touching the nightly job from Part A.

## Further reading

- `nightly_memory_processing_implementation.md` — full implementation design, DDL, phase-by-phase pipeline
  behavior, privacy model, test plan.
- `nightly_memory_processing_concept_v3.md` — the original architecture concept this implementation is
  based on (two-store model: Mistral verbose long-term + MariaDB eager cache).
