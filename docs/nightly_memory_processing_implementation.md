# Nightly Memory Processing — Implementation Concept

**Status**: Implementation concept (developer-actionable)
**Design basis**: `nightly_memory_processing_concept_v3.md`
**Review incorporated**: `feedback_v3_concept.md` (triaged in Appendix C)
**Date**: 2026-07-06
**Target codebase**: this repo (`yasmin-ai`, TypeScript/Node/Express + MariaDB + Mistral)

---

## 0. Scope & non-goals

This targets the **actual deployment**: a single-family, self-hosted assistant with a handful of conversations per day, one MariaDB instance, one Mistral workspace, one app container.

**In scope:** the nightly consolidation job, its MariaDB tables, its Mistral integration, the eager-cache regeneration bridge, retries, locking, recovery, and tests.

**Deliberately out of scope** (from the v3 feedback — disproportionate for this deployment; see Appendix C):
encryption-at-rest / secrets manager, row-level DB security, `audit_log` (versioned `memory_archive` already gives change history), circuit breakers / dead-letter-queue / transactional-outbox, Prometheus metrics, chaos/load testing at 10k scale, parallelizing summarization. If the deployment ever grows multi-tenant, revisit.

---

## 1. Architecture recap (and one refinement)

Two memory levels, each with a real reader (unchanged from v3):

| Store                         | Content                                                          | Reader                                       | Writer                        |
| ----------------------------- | ---------------------------------------------------------------- | -------------------------------------------- | ----------------------------- |
| **Mistral library "memory"**  | verbose long-term (profiles, self-reflection, journals, general) | **conversation agent** via console-wired RAG | nightly job                   |
| **MariaDB `context_entries`** | compressed, sensitive-free grounding                             | conversation agent, turn 1 (eager)           | **nightly job (sole writer)** |
| **MariaDB `memory_archive`**  | full verbose copy, versioned (incl. sensitive)                   | nightly job (read + recovery)                | nightly job                   |

**Refinement vs v3 (robustness, per feedback §1):** the nightly job **reads current verbose content from `memory_archive` (local MariaDB), not from Mistral `text_content`.** We store that copy for backup anyway, so the core update loop has **no runtime dependency on the Mistral read API**. `text_content` remains verified (v3 §5) and is kept only as a recovery/verification tool. Net effect: Mistral is _written_ by the pipeline and _read_ only by the conversation agent's RAG; MariaDB is the durable content source the pipeline works against.

```
day:   conversations happen; live agent READS only (eager + RAG); TODOs stay in the thread
23:00: collect → journal → integrate(read memory_archive) → review
       → write memory_archive (txn) → upload changed files to Mistral
       → regenerate context_entries (compress + strip privacy) → cleanup
```

---

## 2. ONE-TIME SETUP CHANGES ⚠️ (do these before first run)

Everything here is a **manual, one-off** action. The nightly job assumes all of it is already done.

### 2.1 MariaDB (schema)

Apply `database/schema_memory.sql` (DDL in §4) to the `yasmin` database on `192.168.0.2:3307`:

```
mysql -h 192.168.0.2 -P 3307 -u yasmin -p yasmin < database/schema_memory.sql
```

Creates: `memory_archive`, `nightly_job_log`, `processing_lock`. Non-destructive; `context_entries` is untouched.

### 2.2 MariaDB (bootstrap migration — CRITICAL)

The library is empty. Phase 6 regenerates `context_entries` **from** the verbose store, so if the verbose store is empty on first run it would **wipe the existing profiles**. Before the scheduler's first automatic run, run the one-time bootstrap (`scripts/bootstrap-memory.ts`, §7.3):

> Reads current `context_entries` → **merges each `Profile of X` + `Session with X` into one `people/<name>.md`** (5-section template), composes `self-reflection/profile.md` (from `Profile of Yasmin`) and `general/family.md` (from `Family notes`) → inserts them as `memory_archive` v1 → uploads them to the Mistral library.

Safety net (also permanent behavior): **Phase 6 never overwrites a `context_entries` row that has no verbose source** (see §8.4), so a missed bootstrap degrades to "no change," never data loss.

### 2.3 Mistral Console

1. **Library** — the `memory` library already exists in the production workspace. Obtain its **library id** and put it in `MISTRAL_LIBRARY_ID` (§10). _Do not_ reuse the temporary test id from earlier spikes.
2. **Conversation agent** (`AGENT_ID_CONVERSATION`) — attach the `memory` library so it auto-retrieves (RAG). Update its system prompt (`mistral_config/conversation/system_prompt.txt`): add the privacy-enforcement block (§9); note that long-term recall now comes from memory; **remove the write/Session instructions and make it read-only** (done at cutover, §13 — after the nightly job is verified; the privacy block turned out to be unnecessary because the live agent never sees stripped text).
3. **Nightly agent** — create a new agent `yasmin-nightly` with the memory-processor system prompt (§6.3). Library wiring **optional** (only for cross-file discovery; see v3 §1.2). Put its id in `AGENT_ID_NIGHTLY`.
4. **API key** — issue a **production** key with access to the library + both agents; set `MISTRAL_API_KEY`. Verify it can `GET /v1/libraries/{MISTRAL_LIBRARY_ID}` before go-live.

### 2.4 Environment / deployment

1. Add env vars (§10): `MISTRAL_LIBRARY_ID`, `AGENT_ID_NIGHTLY`, `MEMORY_TZ` (default `Europe/Berlin`), optional `NIGHTLY_MAX_RETRIES`.
2. Nothing to build — the app and nightly CLI run directly from source via ts-node (`npm run nightly`), so no `dist/` output is needed at runtime.
3. Start/restart the app (§11) — the in-process scheduler arms itself for the next 23:00 `MEMORY_TZ` automatically; no separate trigger to install.
4. First: run `npm run nightly:dry-run` once and inspect the log.

### 2.5 Checklist

- [ ] `schema_memory.sql` applied (3 tables exist)
- [ ] `MISTRAL_LIBRARY_ID` = production `memory` id; prod key can read it
- [ ] Conversation agent: library attached + privacy prompt updated
- [ ] `yasmin-nightly` agent created; `AGENT_ID_NIGHTLY` set
- [ ] Bootstrap migration run; `memory_archive` seeded; library populated
- [ ] App (re)started so the scheduler arms itself; dry-run reviewed

---

## 3. File / module layout

New (`+`) and changed (`~`) files, following existing conventions (`src/**` → `dist/**`, models under `src/database/models`, CLI under `scripts/`):

```
+ database/schema_memory.sql              DDL for the 3 new tables
+ src/mistral/mistral_api.ts              low-level Mistral HTTP client (retry/pagination)
+ src/database/models/memory_archive.model.ts
+ src/database/models/nightly_job.model.ts   job log + lock
~ src/database/models/context.model.ts    (reuse insert/update; add upsert helper)
~ src/chat_agent.ts                        remove update_context_entry + Session handling (read-only; done at cutover, §13)
~ src/services/context.service.ts          eager set: drop 'Session with X' (sender Profile + Yasmin + Family notes)
- mistral_config/conversation/functions/update_context_entry.json   retired (agent read-only)
+ src/nightly/pipeline.ts                 phase orchestrator
+ src/nightly/tools.ts                    integration tool set (stage_update, …)
+ src/nightly/reflection.ts              prompts + agent calls (journal, integrate, review, compact)
+ src/nightly/privacy.ts                 [PRIVACY:SENSITIVE] stripping, compaction cap
+ src/nightly/mapping.ts                 path ↔ title mapping (§8.2)
+ src/nightly/run.ts                     CLI entry point (arg parsing, --dry-run) -- for manual runs only
+ src/nightly/scheduler.ts               in-process daily scheduler, started from app.ts (§11)
+ scripts/bootstrap-memory.ts            one-time context_entries → verbose seeding
~ src/config.ts                          add mistral.libraryId, mistral.nightlyAgentId, nightly.*
~ mistral_config/conversation/system_prompt.txt   + privacy block; remove write/Session instructions (read-only)
+ mistral_config/nightly/nightly_system_prompt.txt   yasmin-nightly agent prompt
+ src/__tests__/… (see §12)
```

---

## 4. Data model (DDL)

`database/schema_memory.sql`:

```sql
-- Full verbose copy of every long-term file, versioned. Durable source + backup.
CREATE TABLE IF NOT EXISTS memory_archive (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  file_path      VARCHAR(255) NOT NULL      COMMENT 'e.g. people/christopher.md',
  content        MEDIUMTEXT   NOT NULL      COMMENT 'full verbose content (may include [PRIVACY:SENSITIVE])',
  content_hash   CHAR(64)     NOT NULL      COMMENT 'SHA-256 of content',
  version        INT          NOT NULL      COMMENT 'monotonic per file_path; MAX = current',
  mistral_doc_id VARCHAR(64)  NULL          COMMENT 'Mistral document id of the uploaded copy',
  synced_at      TIMESTAMP    NULL          COMMENT 'set when this version was confirmed uploaded',
  created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_path_version (file_path, version),
  INDEX idx_path (file_path),
  INDEX idx_unsynced (file_path, synced_at)      -- find versions needing (re)upload
);
-- Current version of a file = row with MAX(version) for that file_path.

CREATE TABLE IF NOT EXISTS nightly_job_log (
  id                         INT AUTO_INCREMENT PRIMARY KEY,
  started_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at               TIMESTAMP NULL,
  status                     ENUM('running','completed','partial','failed') NOT NULL DEFAULT 'running',
  last_completed_phase       VARCHAR(32) NULL,
  processed_conversation_ids JSON NULL,
  skipped_conversation_ids   JSON NULL,       -- conversations that failed a phase and were skipped
  error_message              TEXT NULL,
  conversations_processed    INT DEFAULT 0,
  files_updated              INT DEFAULT 0,
  files_created              INT DEFAULT 0,
  INDEX idx_status_completed (status, completed_at)   -- watermark query
);

CREATE TABLE IF NOT EXISTS processing_lock (
  lock_name   VARCHAR(64) PRIMARY KEY,         -- 'nightly'
  acquired_at TIMESTAMP NOT NULL,
  owner       VARCHAR(128) NOT NULL            -- host:pid
);
```

**Design notes (answering feedback):**

- `MEDIUMTEXT` (16 MB), not `LONGTEXT`: a single markdown profile is KBs; 16 MB is ~4 orders of magnitude of headroom. `LONGTEXT` would only waste row-format budget.
- `synced_at` replaces the vague "mistral_doc_id NULL" gap: any current version with `synced_at IS NULL` is re-uploaded next run (idempotent retry).
- `skipped_conversation_ids` + `partial` status make skips observable.
- Watermark = `MAX(completed_at) WHERE status='completed'`.
- No `is_current` flag (v2's dual-current bug); current = `MAX(version)`.

**Example `memory_archive` row:**

```
id=42 file_path='people/christopher.md' version=7 content_hash='a1b2…'
mistral_doc_id='fdfe66e9-…' synced_at='2026-07-06 03:01:12' content='---\nname: Christopher\n…'
```

**Example failed `nightly_job_log` row:**

```
status='partial' last_completed_phase='4-archive'
processed_conversation_ids=['conv_a','conv_b'] skipped_conversation_ids=['conv_c']
error_message='Mistral upload 503 for people/zara.md after 3 retries'
```

---

## 5. Mistral API client (`src/mistral/mistral_api.ts`)

Single module wrapping all Mistral HTTP, with **exponential backoff + jitter** (default 3 retries on 429/5xx/network) and **response validation** (zod, already a dependency) on the fields we consume.

```ts
// conversations
listConversations(sinceIso: string): Promise<ConvMeta[]>          // GET /v1/conversations (+ pagination)
getConversationMessages(id: string): Promise<Message[]>          // GET /v1/conversations/{id}/messages
deleteConversation(id: string): Promise<void>                    // DELETE (204/404 both OK)
askAgent(agentId: string, input: string|Message[], tools?): Promise<AgentResponse> // POST /v1/conversations

// library documents
listDocuments(): Promise<DocMeta[]>                              // GET …/documents  (cursor pagination)
uploadDocument(path: string, content: string): Promise<DocMeta> // POST multipart; filename=path (slashes OK)
deleteDocument(docId: string): Promise<void>                     // DELETE …/documents/{docId}
```

**Verified behaviors baked in (v3 §5):** filename preserves slash paths; identical content dedupes by hash; **no in-place update → `replaceDocument(path)` = upload new content then delete the old `mistral_doc_id`** (upload-first so a mid-failure leaves at worst a stale duplicate, never a missing document); uploads are async (don't block on `process_status`); list is paginated (`page_size` 1000, `has_more`) → follow pages.

`getTextContent` (recovery/verification tool, GET …/text_content) was removed as unused dead code -- reintroduce it if a manual recovery workflow needs it.

`withRetry(fn, {retries, baseMs, jitter})` helper wraps every call. All 4xx except 429 fail fast (no retry).

---

## 6. Nightly pipeline (`src/nightly/pipeline.ts`)

Orchestrates phases; each writes `last_completed_phase` for resume. The caller (the scheduler, or the CLI entry point for a manual run) catches, marks `failed`/`partial`, releases lock; a failure just surfaces as an `ERROR` log line (§11) -- there is no separate alerting step.

### 6.1 Phases

**Phase 1 — Collect.** Acquire lock (§6.2). Watermark = last successful `completed_at` (fallback 24 h if none/corrupt; guard against future timestamps from clock skew). `listConversations(sinceWatermark)`; persist ids to `processed_conversation_ids`. Empty → mark `completed`, release, exit.

**Phase 2 — Journal.** For each conversation: `getConversationMessages` → `askAgent(nightly, journalPrompt(messages))` → structured journal. Write to `memory_archive` (`journals/<user>/<conv_id>.md`, version 1) **and** upload to Mistral. On failure: retry (backoff); still failing → add to `skipped_conversation_ids`, continue (a skipped conversation is **not** deleted in Phase 7, so it retries next night). Cap journal length; oversized → summarize-again with a tighter instruction.

**Phase 3 — Integrate.** One `askAgent(nightly, integrationPrompt, tools)` tool loop (`maxIterations` 15). Tools (§7): reads come from `memory_archive`; the AI **stages** proposed verbose updates via `stage_update`. Returns the staged list. No real store is written yet.

**Phase 4 — Review + Archive.** For each staged update: `askAgent(nightly, reviewPrompt(update, currentContent, lastTouchedAt, todaysJournals))` → per-file verdict (structured JSON). Rejected files → quarantined (kept at current version, logged), **not** batch-aborted. Accepted files: in one transaction, insert new `memory_archive` versions (skip if `content_hash` unchanged → no churn). Commit **before** any Mistral write.

**Phase 5 — Upload.** For each current version with `synced_at IS NULL`: `replaceDocument(path, content)` (delete old `mistral_doc_id`, upload, store new id), set `synced_at`. On failure: retry; still failing → leave `synced_at` NULL (retried next run) and mark job `partial`. **Orphan reconcile:** `listDocuments()`; delete any Mistral doc whose path is not the current archive row (handles renames / failed prior deletes).

**Phase 6 — Regenerate eager cache.** §8. Compress + strip privacy, map path→title, upsert `context_entries`. Non-destructive for titles lacking a verbose source.

**Phase 7 — Cleanup.** Delete **only** `processed − skipped` conversations from Mistral (204/404 OK). Prune `memory_archive` to last N=10 versions/path (keep ≥2). Prune `nightly_job_log` older than 90 days. Mark `completed`; release lock.

### 6.2 Locking

`acquireLock('nightly', owner=host:pid)`: `INSERT`; on duplicate, if `acquired_at` older than `LOCK_STALE_MS` (default 2 h) steal it, else abort ("another run active"). Always release in `finally`. Covers job-vs-job; the job-vs-live-chat race (§6.4) is separate.

### 6.3 Agents & prompts

- `yasmin-nightly` agent, `mistral_config/nightly/nightly_system_prompt.txt`: "You are Yasmin's memory consolidator. Return only the requested structured output. No chat persona." Distinct from the chat persona → no `[REFLECTION_TRIGGER]` hack.
- Phase 2 accesses transcripts via `getConversationMessages` and feeds the nightly agent (decouples from the conversation agent).

### 6.4 Live-vs-nightly write race

**Eliminated by design.** The nightly job is the sole writer of `context_entries`; the live conversation agent is read-only (memory reads = eager load + RAG). Within-day TODOs live in the conversation thread and are consolidated at night, so there is no concurrent writer to race with.

---

## 7. Integration tools (`src/nightly/tools.ts`)

```ts
list_long_term_files(); // current versions from memory_archive: [{path, contentHash, lastTouchedAt}]
//   (lastTouchedAt = created_at of the current version; a file-level hint for the decay rule --
//   fact age is judged by the in-content dates, and bootstrap-seeded files share one timestamp)
// Decay rule: dated facts not corroborated for >180 days are deleted when the file is rewritten.
get_long_term_file(path); // memory_archive current content (local, exact — no Mistral call)
read_todays_journals(); // this run's Phase-2 journals (the evidence base)
stage_update(path, content, isNew); // append to in-run staged list  ← the ONLY writer
```

`stage_update` is the single authoritative source of proposed updates (fixes v2's phantom `proposedUpdates`). Staged list lives in the run process; if the job dies before Phase 4 nothing is written (safe — re-run regenerates). Feedback's "single point of failure" is intentional atomicity: **all-or-nothing per run at the archive transaction**, not partial.

---

## 8. Eager-cache regeneration (the bridge)

### 8.1 Compression (`src/nightly/privacy.ts` + `reflection.ts`)

`context_entries.content` is prepended to every prompt → must be small and clean. **Compression = LLM compaction** by the nightly agent to a strict template, then enforced:

- Hard cap **2000 chars/entry**; over cap → one re-compact attempt, then deterministic truncate with `…[truncated]`.
- Strip all `[PRIVACY:SENSITIVE]` blocks **before** compaction.
- Mistral's auto-generated per-doc `summary` (v3 §5) is offered to the compactor as a starting point.

### 8.2 Mapping (`src/nightly/mapping.ts`)

**One eager entry per person.** `Session with X` and `Journal with X` are **retired** (facts + proactive topics merge into `Profile of X`; deep history lives in Mistral journals via RAG).

| Verbose path                 | Eager title         | Transform                                                                                                                                                                                                    |
| ---------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `people/<name>.md`           | `Profile of <Name>` | LLM-compact to the 7-section template (Core Facts, Current Attitude, Ideas/Interests/Goals, Recent Happenings, Open Topics, Communication Style, Yasmin's Intentions); strip `[PRIVACY:SENSITIVE]`; cap 2 KB |
| `self-reflection/profile.md` | `Profile of Yasmin` | compact (first-person)                                                                                                                                                                                       |
| `general/family.md`          | `Family notes`      | compact                                                                                                                                                                                                      |

Eager set loaded on turn 1 = `Profile of <sender>` + `Profile of Yasmin` + `Family notes`.

### 8.3 Name/case

`people/christopher.md` → `Profile of Christopher` (capitalize file stem). Multi-word stems use existing title casing (`anjali.md`→`Anjali`). Mapping is table-driven and unit-tested.

### 8.4 Safety

`upsertContextEntry(title, content)` only updates an **existing** title, or inserts a title that maps from a present verbose file. A title with no verbose source is left untouched → a missed bootstrap never wipes profiles.

---

## 9. Privacy

- **Eager cache: always sensitive-free.** `[PRIVACY:SENSITIVE]` blocks stripped in Phase 6 before compaction. Non-negotiable (eager is injected unconditionally).
- **`memory_archive`: full content** including sensitive (durable truth).
- **Mistral library (default): keeps sensitive**, with **answer-time enforcement** via the conversation agent's system prompt (block added in 2.3): _"Content marked [PRIVACY:SENSITIVE]: use only as a direct answer when the user explicitly asks about that exact topic; never proactively, for creative connections, or for inferences."_
  - ⚠️ **Known residual risk (accepted):** the library is shared across family members and RAG has no per-person access control, so enforcement relies on the LLM not surfacing person A's sensitive chunk while chatting with person B. Accepted for usability (Yasmin can recall e.g. a surprise-party plan for the right person). **Future hardening:** strip sensitive from the upload + add a gated recall tool that checks the requester against the person the fact concerns.
- Journals inherit the same handling (they can contain sensitive context).
- Broader PII auto-detection (phone/address) is a future enhancement, not v1.

---

## 10. Configuration (`src/config.ts` additions)

```ts
mistral: {
  …,
  libraryId:     process.env['MISTRAL_LIBRARY_ID']!,   // production "memory" library id
  nightlyAgentId: process.env['AGENT_ID_NIGHTLY']!,
  apiRoot: 'https://api.mistral.ai/v1',
},
nightly: {
  tz:            process.env['MEMORY_TZ'] || 'Europe/Berlin',
  maxRetries:    parseInt(process.env['NIGHTLY_MAX_RETRIES'] || '3'),
  lockStaleMs:   2 * 60 * 60 * 1000,
  maxIterations: 15,
  archiveKeepVersions: 10,
  eagerMaxChars: 10000,
}
```

`validateEnv()` requires `MISTRAL_LIBRARY_ID`, `AGENT_ID_NIGHTLY`, `DB_PASSWORD` when running the nightly entrypoint (detect via `process.argv[1]` like the existing `manage-context` check). Secrets stay in env (a secrets manager is out of scope, §0); ensure logs never print `MISTRAL_API_KEY` (client redacts headers).

---

## 11. Scheduling & ops runbook

**In-process scheduler** `src/nightly/scheduler.ts`, started from `app.ts` alongside the API server (no
external cron/systemd unit, no wrapper script): it computes the next 23:00 (or whatever `MEMORY_TZ`
resolves to) using the container's own clock/timezone data, `setTimeout`s to it, calls the exact same
`runNightlyPipeline()` the manual CLI (`src/nightly/run.ts`) calls, logs the result, and reschedules for
the next day. Running in the same process as the server means it always has the exact same env vars and
`node` executable — nothing extra to wire up when the app is deployed as a container. `src/nightly/run.ts`
(`npm run nightly` / `npm run nightly:dry-run`) remains available for a manual one-off run or preflight
check; it is no longer how the nightly recurrence itself is triggered.

**Container base image note:** `nextRunAt`'s timezone math uses `Intl.DateTimeFormat` with an IANA zone
name (`MEMORY_TZ`, default `Europe/Berlin`) -- this throws a `RangeError` at scheduler startup on a Node
build without full ICU data (some minimal/slim base images ship Node with small-icu only). Verify
`node -e "new Intl.DateTimeFormat('en-US',{timeZone:process.env.MEMORY_TZ||'Europe/Berlin'})"` succeeds in
whatever image this actually deploys to; if not, install the `full-icu` package or use a base image built
with full ICU.

**Runbook:**
| Symptom | Action |
|---|---|
| `status='failed'/'partial'` | Read `error_message`; safe to re-run — resumes via `last_completed_phase`, hash-guarded writes are idempotent. |
| Stale lock (crash) | Auto-broken after `lockStaleMs`; or `DELETE FROM processing_lock WHERE lock_name='nightly'`. |
| Mistral out of sync / manual edit | Re-run: Phase 5 re-uploads `synced_at IS NULL`; orphan-reconcile removes strays. Full rebuild: re-upload all current `memory_archive` versions. |
| Bad AI update to a file | Restore a **chosen prior** version from `memory_archive` (keep ≥2), set `synced_at=NULL`, re-run Phase 5+6. |
| Content integrity check | `SHA256(content) == content_hash` on read; mismatch → restore prior version. |
| Backups | Nightly `mysqldump` of `context_entries` + `memory_archive` before 23:00. |

---

## 12. Test cases (`src/__tests__/`)

Existing harness: Jest + ts-jest, global `fetch` mocked, `dbProxy` uses `PROXY_DATA` when `NODE_ENV=test`. New tests follow that.

### 12.1 Unit

- **memory_archive.model**: insert v(n+1); `getCurrent` returns MAX(version); unchanged hash ⇒ no new version; prune keeps last N and ≥2; `synced_at` set/queried.
- **nightly_job.model**: create/complete log; watermark = latest `completed`; lock acquire → duplicate aborts → stale lock stolen after timeout.
- **privacy.stripSensitive**: removes `[PRIVACY:SENSITIVE]…` blocks, preserves surrounding text; multiple blocks; none present ⇒ unchanged.
- **compaction cap**: > cap ⇒ truncated with marker; ≤ cap ⇒ untouched.
- **mapping**: `people/christopher.md`↔`Profile of Christopher`; `self-reflection/profile.md`↔`Profile of Yasmin`; unmapped path ⇒ ignored.
- **mistral_api.withRetry**: 429→429→200 succeeds after backoff; 400 fails immediately; pagination assembles 2 pages; `replaceDocument` calls delete-then-upload in order.
- **tools**: `stage_update` accumulates; `get_long_term_file` reads archive (no fetch call).
- **safety**: `upsertContextEntry` leaves a source-less title untouched.
- **read-only agent** (post-cutover): `chat_agent` exposes no `update_context_entry`; eager set = sender `Profile` + `Profile of Yasmin` + `Family notes` (no `Session with X`).

### 12.2 Integration (mocked Mistral, test DB/proxy)

- **Happy path**: 3 mock conversations ⇒ 3 journals, archive versions written, `context_entries` regenerated (sensitive-free, ≤ cap), conversations deleted, `status='completed'`.
- **Change detection**: identical content ⇒ no new version, no upload call.
- **Reviewer rejects one file**: quarantined at prior version; others applied; `status='partial'` not aborted.
- **Resume**: inject crash after each phase ⇒ re-run continues from `last_completed_phase`, no duplicate journals/uploads/deletes.
- **Skipped conversation**: Phase 2 fails for conv C ⇒ C in `skipped_conversation_ids`, C **not** deleted, others proceed.
- **Orphan reconcile**: library has a doc absent from current archive ⇒ deleted in Phase 5.
- **Concurrency**: second run sees lock ⇒ aborts.
- **Upload retry**: Mistral 503 then 200 ⇒ `synced_at` set, no dup; persistent 503 ⇒ `synced_at` NULL, `partial`, retried next run.
- **Bootstrap**: `context_entries` ⇒ verbose files ⇒ archive v1 + uploads; then a normal run doesn't wipe anything.

### 12.3 Manual Mistral spike (live prod key — answers feedback's open questions)

Run once against a scratch library before go-live:

- `text_content` on a >1 MB markdown file: fidelity + latency + any rate limit.
- delete-then-upload + identical-content dedup (re-confirm at prod scale).
- two near-simultaneous uploads of the same path (race outcome).
- production key can `GET` the `memory` library; capture its id.
- list with >1000 docs (or confirm pagination fields) — if infeasible, note the cap is far off.

---

## 13. Rollout sequence

1. Land code + `schema_memory.sql` + tests (green) as the first (additive) change; review and merge.
2. Apply schema to MariaDB (§2.1).
3. Mistral console: get prod library id, attach to conversation agent, create `yasmin-nightly`, update prompts, issue prod key (§2.3). Run the manual spike (§12.3).
4. Set env vars; `npm run build`.
5. **Bootstrap migration** (§2.2); verify `memory_archive` seeded + library populated + `context_entries` unchanged.
6. `npm run nightly:dry-run`; inspect log (no writes in dry-run).
7. One real manual run; verify journals, archive, regenerated eager cache, cleanup.
8. Restart the app; the in-process scheduler arms itself automatically. Monitor `nightly_job_log` for a while.
9. **Cut over to the read-only agent** (done; only after the nightly job is verified over several nights): update the conversation agent's system prompt (remove write/Session instructions), retire the `update_context_entry` tool in `chat_agent.ts`, and drop `Session with X` from the eager set in `context.service.ts`. Until this step, live writes keep memory fresh — do not remove them earlier (avoids a consolidation gap).

---

## 14. Decisions (finalized 2026-07-06)

| Topic                  | Decision                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read source (Phase 3)  | **`memory_archive`** (local, exact) — no runtime dependency on the Mistral read API. MariaDB is the durable content source; Mistral is a derived search projection.                                                                                                                                                                                                                                                   |
| Compression (Phase 6)  | **LLM compaction** by the nightly agent to the 7-section template; 2000-char cap; deterministic truncate fallback.                                                                                                                                                                                                                                                                                                    |
| Sensitive in library   | **Revised:** stripped before Phase 5's upload too, not just the eager cache -- `[PRIVACY:SENSITIVE]` content never leaves local storage (`memory_archive` keeps it for versioning/audit only). Data minimization won over the original "keep in library + answer-time prompt enforcement" design, which relied entirely on the live agent's prompt discipline to gate a marker the RAG layer could otherwise surface. |
| Eager entry per person | **Single `Profile of <Name>`** = facts + proactive topics (Core Facts, Current Attitude, Ideas/Interests/Goals, Recent Happenings, Open Topics, Communication Style, Yasmin's Intentions). **`Session with X` retired.**                                                                                                                                                                                              |
| Journals               | **Per-conversation files in Mistral only** (RAG). **`Journal with X` retired** — short-term arc lives in Profile's Recent Happenings.                                                                                                                                                                                                                                                                                 |
| Live agent             | **Read-only** for memory; nightly job is the **sole writer**. `update_context_entry` retired. Keep live writes until the nightly job ships, then flip (§13).                                                                                                                                                                                                                                                          |
| Reflection             | Dedicated **`yasmin-nightly`** agent; transcripts via `getConversationMessages` (no `[REFLECTION_TRIGGER]`).                                                                                                                                                                                                                                                                                                          |
| Scheduling             | **Revised:** in-process scheduler (`src/nightly/scheduler.ts`, started from `app.ts`) instead of cron + failure email -- no external unit/wrapper script, and a failure is just an `ERROR` log line rather than a separate alert.                                                                                                                                                                                     |

No open defaults remain.

---

## Appendix A — Sequence (happy path)

```
scheduler (23:00) → runNightlyPipeline → acquireLock
 P1 list(since watermark) ─ persist ids
 P2 for conv: getMessages → nightly.journal → archive(v1) + upload
 P3 nightly.integrate [get_long_term_file(archive), read_todays_journals, stage_update*] → staged[]
 P4 for u in staged: nightly.review(u, current, journals); accepted → BEGIN insert archive vN; COMMIT
 P5 for current where synced_at NULL: replaceDocument; set synced_at ; reconcile orphans
 P6 for path: compact+strip → upsert context_entries (mapped title)
 P7 delete (processed−skipped) convs; prune; status=completed → releaseLock
```

## Appendix B — Error codes handled

`429/5xx` → retry+backoff; `4xx` (non-429) → fail fast; conversation `DELETE 404` → treat as done; DB `ER_GET_CONNECTION_TIMEOUT/ETIMEDOUT` → existing retry (`connection.ts`); lock duplicate → abort or steal-if-stale.

**Watermark staleness cutoff (poison-pill valve):** a `partial` run never advances the watermark, so a
conversation that fails journaling every night would freeze it indefinitely (each subsequent run
re-collects a growing batch while the blocked conversation never clears). When the watermark has been
stalled longer than `config.nightly.watermarkStalenessMs` (10 days) **and** the current run actually
skipped conversations (`skippedIds` non-empty — other `partial` causes like upload/eager/delete
failures are self-healing and independent of the watermark), the run abandons the stalled window:
the watermark advances to `now - watermarkStalenessMs`, bounding the data loss to the threshold
window instead of blocking forever. The abandonment is loud (ERROR log + `errorMessage` on the job
row listing the abandoned conversation ids) so the permanent loss stays auditable.

## Appendix C — Feedback triage (`feedback_v3_concept.md`)

**Adopted:** retry/backoff (§5), `processing_lock` schema (§4), upload tracking via `synced_at` + orphan reconcile (§6.5), `skipped` status (§4), compression rules + cap (§8.1), pagination (§5), timezone (§10), log/version pruning (§6 P7), Phase-1 fallback/clock-skew guard (§6.1), lock timeout (§6.2), response validation (§5), read-from-archive to remove `text_content` runtime dependency (§1), example rows (§4), code references throughout, path↔title mapping table (§8.2).
**Adopted-partial:** "single point of failure" in `stage_update` — kept as intentional per-run atomicity (§7); journal size limits — cap + re-summarize (§6.1 P2).
**Deferred (future):** broader PII detection (§9), soft-delete of conversations (journal is the record; skipped convs already survive), systemd restart policy (§11 optional).
**Rejected as out-of-scope for a single-family deployment (§0):** encryption-at-rest / secrets manager, row-level security, `audit_log` (versioning covers it), circuit breaker / DLQ / transactional-outbox, Prometheus, chaos/load testing at 10k, parallelized summarization, `LONGTEXT`, hash-collision/version-overflow handling.

```

```
