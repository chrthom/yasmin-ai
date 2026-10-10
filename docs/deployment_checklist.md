# Nightly Memory Processing — Read-Only Cutover Checklist

**Status**: developer-actionable, manual ops steps for deploying the read-only live agent
**Full design**: `nightly_memory_processing_implementation.md` (§2 one-time setup, §11 runbook, §13 rollout)
**Prerequisite**: the nightly job (pipeline, `memory_archive`, Mistral library upload) is deployed and has run
cleanly in production for a while. Do not deploy the read-only agent before that: until then the live
agent's writes are what keeps `context_entries` fresh.

After this cutover the live conversation agent is **read-only for memory**: the nightly job is the sole
writer of `context_entries`, the old `Session with X` / `Journal with X` entries are retired for good, and a
restarted conversation is seeded with a summary and the last turns of the previous one (see `AGENTS.md`,
"Conversation restarts and the handoff").

---

## 1. Deploy order matters: code first, data cleanup after

Deploy the code (it stops the live agent from writing) before you apply the `schema.sql`/data cleanup to a
running database, not the other way around. A stale `update_context_entry` write attempt against an
already-removed `Session with X` row would silently no-op, which only becomes correct behavior once the code
no longer tries (see `CONTEXT_CONVENTIONS.md` §2.1).

## 2. Mistral Console

1. **Live conversation agent** (not the nightly one): remove its `update_context_entry` function registration
   and update its system prompt to the current `mistral_config/conversation/system_prompt.txt`. Attach the
   `memory` library if it is not attached yet. A stray `update_context_entry` call from a stale definition is
   answered with an error result by the code, so a missed step here is harmless but wasteful.

---

## Cross-person notes (intraday_notes) -- deploy steps for the share_note feature

The steps above are the one-time cutover runbook of the read-only memory change and are done.
This section is separate: it is what a deploy of the cross-person notes feature (issue #46)
needs -- apply it on its own, independently of the cutover above.

1. Apply the `intraday_notes` table from `database/schema.sql` to the database **before**
   deploying the code -- otherwise every `share_note` call and every note lookup on prompt
   build fails. Failures are non-fatal (the chat keeps working, notes simply stay undelivered),
   but the feature is dead until the table is in place.
2. Register the `share_note` tool on the live conversation agent in Mistral Studio
   (definition in `mistral_config/conversation/functions/share_note.json`) and update its
   system prompt to the current `mistral_config/conversation/system_prompt.txt`.
3. Verify: ask the agent to tell another person something, confirm the row in `intraday_notes`,
   then message as that person and check for the `<nachrichten_fuer_dich>` block in the server
   log. An "everyone" note must never be delivered back to its own sender (the delivery query
   filters `from_username != ?`).
4. **Summarizer agent** (new): create an agent with a small model (`mistral-small-latest` is plenty), no tools,
   no library, and the system prompt from `mistral_config/summarizer/system_prompt.txt`. Set its id as
   `AGENT_ID_SUMMARIZER` in the server's environment. It is optional: without it a conversation restart only
   replays the last 3 turns instead of a summary plus the last 3 turns. The agent is called one-shot with
   `store: false`; no conversations accumulate for it.

## 3. Deploy the code

Have a real conversation afterward and confirm: profile/family-notes context loads correctly on turn 1, and
the agent no longer attempts (or is able) to write memory. To exercise the handoff, lower
`MAX_TURNS_PER_SESSION` temporarily (for example to `3`), chat past it, and check that the next answer
continues the thread and that the summarizer agent left no conversations behind in Studio.

## 4. (Optional) Purge stale rows from the already-running production database

The updated `schema.sql` only affects _fresh_ installs, it won't retroactively delete existing rows:

```sql
DELETE FROM context_entries WHERE title LIKE 'Session with %' OR title LIKE 'Journal with %';
```

Run this only after `scripts/bootstrap-memory.ts` has been run (it reads the old `Session with X` rows once as
input), and only after the code is deployed. Harmless to skip: those rows just sit there unused.

## 5. Keep monitoring

The nightly job is the sole writer of `context_entries` from this point on; `nightly_job_log` is only that
job's run log and never writes context itself.

---

## Rollback

See `nightly_memory_processing_implementation.md` §11 for the full runbook (stale lock recovery, restoring a
prior `memory_archive` version, re-running a partial/failed job, etc.). Redeploying the previous
`chat_agent.ts` / `context.service.ts` / `system_prompt.txt` restores live write access without touching the
nightly job.

## Further reading

- `nightly_memory_processing_implementation.md` — full implementation design, DDL, phase-by-phase pipeline
  behavior, privacy model, test plan.
- `nightly_memory_processing_concept_v3.md` — the original architecture concept this implementation is
  based on (two-store model: Mistral verbose long-term + MariaDB eager cache).
