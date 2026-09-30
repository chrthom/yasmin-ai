# Nightly Memory Processing Concept - v3.0

**Version**: 3.0 — Mistral-Long-Term + MariaDB-Eager-Cache + Passive Backup
**Status**: Concept (polished) — precedes the implementation concept
**Date**: 2026-07-06
**Supersedes**: `nightly_memory_processing_concept_v2.md` (v2.0)

---

> **⚠️ Finalized decisions (2026-07-06) live in `nightly_memory_processing_implementation.md` §14 and supersede any conflicting detail below.** Changes since this concept was written:
>
> - **One eager entry per person** (`Profile of X` = facts + proactive topics). **`Session with X` and `Journal with X` are retired.**
> - **Live agent is read-only**; the nightly job is the **sole writer** of `context_entries` (`update_context_entry` retired).
> - **Phase 3 reads current content from `memory_archive`** (local), not Mistral `text_content` — so `memory_archive` is the durable content source and Mistral a derived search projection.
> - **Journals: per-conversation in Mistral only** (RAG); short-term arc lives in Profile's Recent Happenings.

---

## 📋 Document Change Log

| Version | Date       | Key Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0     | 2026-07-05 | Initial concept: Mistral Library as long-term source of truth, MariaDB as compacted eager-loading cache, nightly job with `update_shortterm_context_entry` bridge.                                                                                                                                                                                                                                                                                                                |
| 2.0     | 2026-07-06 | Architectural inversion to "MariaDB `knowledge_files` = source of truth, Mistral = read-only cache." Added changelog, AI reviewer, throttling, recovery.                                                                                                                                                                                                                                                                                                                          |
| 3.0     | 2026-07-06 | **Corrected the false premise behind v2** (Mistral _can_ return document content). Restored the two-level model (Mistral long-term + MariaDB eager cache) with a **single versioned MariaDB backup table** used passively for recovery. Removed the redundant `knowledge_files` current-table, the throttle, and the write-only Mistral sync framing. Restored and made explicit the **eager-cache regeneration bridge** that v2 dropped. Reconciled naming with the actual code. |

### Why v2 needed correcting

v2's entire "architectural inversion" rested on this claim:

> _"Mistral's Knowledge Library API cannot retrieve file content — `GET /v1/libraries/{id}/documents` returns only metadata."_

**This is false.** The `/documents` endpoint is the _collection listing_ (metadata by design). Per-document **content is retrievable**:

```
GET https://api.mistral.ai/v1/libraries/{library_id}/documents/{document_id}/text_content
# SDK: client.beta.libraries.documents.text_content(library_id, document_id)
# Also available: extracted_text signed URL, raw signed URL
```

Sources: [Mistral Libraries docs](https://docs.mistral.ai/studio-api/knowledge-rag/libraries), [Document Library connector](https://platform-docs-public.pages.dev/agents/connectors/document_library/).

Because content _can_ be read back, the nightly job can make informed updates to verbose memory without a local mirror being the source of truth. That removes v2's reason to promote MariaDB to source of truth and to demote Mistral to a "read-only cache with no reader." v3 returns to the natural division of labour.

---

## 🎯 Executive Summary

Yasmin has **two levels of memory**, each with a clear reader:

1. **Long-term memory** lives in the **Mistral Knowledge Library** (verbose profiles, self-reflection, per-conversation journals, general topics). Its value is Mistral's **built-in semantic search** — we get vector retrieval for free instead of building embeddings/full-text search ourselves.
2. **Eagerly-loaded context** lives in **MariaDB `context_entries`** (highly compressed profiles + session notes). It is prepended to the first turn of every conversation so Yasmin is grounded instantly, with no retrieval latency.

MariaDB additionally holds a **passive versioned backup** of the verbose long-term entries (`memory_archive`). It is **not read during normal processing** — it exists solely to (a) rebuild the Mistral library if it is lost or corrupted, and (b) roll back a bad nightly update.

The **nightly job** is the consolidation engine (sleep-stage inspired: N2 stabilize → N3 integrate → REM emotional/self-update). Each night it turns the day's conversations into journals, revises the verbose long-term memory in Mistral, and **regenerates the compressed `context_entries`** so that the running assistant actually sees what was consolidated.

```
┌──────────────────────────────────────────────────────────────────────┐
│                        YASMIN AI — v3.0 MEMORY                          │
├──────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  READ PATHS (during a conversation)                                    │
│   • Turn 1 eager load .......... MariaDB  context_entries  (compressed)│
│   • On-demand semantic recall .. Mistral  Knowledge Library (verbose)  │
│                                                                        │
│  ┌─────────────────────────┐         ┌──────────────────────────────┐ │
│  │ MariaDB context_entries │         │  Mistral Knowledge Library    │ │
│  │  (compressed, eager)    │◄──┐     │  (verbose, semantic search)   │ │
│  └─────────────────────────┘   │     └───────────────▲──────────────┘ │
│                                 │                     │ upload (derived)│
│  ┌─────────────────────────┐   │ regenerate          │                 │
│  │ MariaDB memory_archive  │───┘ (nightly)   ┌────────┴────────┐        │
│  │  (versioned backup —    │◄────────────────│  NIGHTLY JOB    │        │
│  │   passive, recovery)    │  commit FIRST   │  (cron, 03:00)  │        │
│  └─────────────────────────┘                 └─────────────────┘        │
│     ▲ durable write-ahead record: MariaDB is committed before Mistral   │
│       upload, so recovery can always re-push MariaDB → Mistral.         │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 1. Architecture

### 1.1 Component responsibilities

| Component                     | Role                                         | Read by                                                                                 | Written by                                              |
| ----------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Mistral Knowledge Library** | Verbose long-term memory + semantic search   | Conversation agent (semantic recall) + nightly job (reads current content to update it) | Nightly job (derived from MariaDB)                      |
| **MariaDB `context_entries`** | Compressed, eagerly-loaded grounding context | Conversation agent (turn 1)                                                             | Nightly job (**sole writer**) — live agent is read-only |
| **MariaDB `memory_archive`**  | Versioned backup/mirror of verbose entries   | **Recovery only** (passive)                                                             | Nightly job (before Mistral upload)                     |
| **MariaDB `nightly_job_log`** | Execution tracking / resumability            | Ops + next run (last-success watermark)                                                 | Nightly job                                             |
| **Nightly job**               | Consolidation pipeline                       | —                                                                                       | Runs daily 03:00                                        |

Note the direction of authority: **MariaDB `memory_archive` is the durable record; Mistral is the derived, eventually-consistent search index.** The archive is "passive" only in the sense that no _feature_ reads it — it is authoritative for recovery.

### 1.2 The two-level bridge (what v2 dropped)

The two levels use **different keys and different verbosity**, so a translation step is mandatory:

|         | Long-term (Mistral)                                      | Eager cache (`context_entries`)                  |
| ------- | -------------------------------------------------------- | ------------------------------------------------ |
| Key     | file path — `people/christopher.md`                      | title — `Profile of Christopher`                 |
| Content | verbose, full history, may contain `[PRIVACY:SENSITIVE]` | compressed to the essentials, **sensitive-free** |
| Reader  | semantic recall (lazy)                                   | prepended on turn 1 (eager)                      |

The nightly job's **regeneration phase** performs: `path → title` mapping + compression/summarization + privacy stripping. v1 did a version of this via an `update_shortterm_context_entry` tool; **v2 removed it and never replaced it**, which left the eager cache frozen (nightly consolidation was invisible to the live assistant). v3 restores it as an explicit phase (see §4, Phase 6).

> ✅ **Mistral read path — decided.** The Knowledge Library is wired in the Mistral console to the **conversation agent** (`yasmin-conversation`), which therefore performs semantic retrieval (RAG) over it automatically — no application code in `src/chat_agent.ts` is needed for long-term recall. `read_context_entry` continues to serve the compressed eager cache.
>
> **Does the _nightly_ agent need the library wired? No.** The nightly job's core read (Phase 3) needs the _full current_ file to rewrite it, and RAG returns _chunks_, not whole files — so RAG is the wrong tool for that read. Full files are read deterministically from the local **`memory_archive`** (finalized decision — no runtime dependency on the Mistral read API; `text_content` remains verified in §5 as a recovery tool). Wiring the library to `yasmin-nightly` is therefore **optional** — enable it only if you want the nightly AI to do semantic _cross-file discovery_ during integration ("what else do I already know about this?"), and even then pass the full target file explicitly for the rewrite.

### 1.3 Data flow during a conversation

```
User message
   │
   ▼
ChatAgent (src/chat_agent.ts)
   1. Turn 1 → eager-load compressed context from MariaDB context_entries
      (Profile of <sender>, Family notes, Profile of Yasmin)   [Session with X retired]
      → prepend as <context_entry title="…">…</context_entry>
   2. On demand → semantic recall from Mistral library via console-wired RAG
   (No live memory writes — the agent is read-only; consolidation is nightly.)
   ▼
Response
```

---

## 2. MariaDB Schema

### 2.1 Existing — `context_entries` (unchanged)

The live eager cache. **Schema is not modified by this work.**

```sql
CREATE TABLE IF NOT EXISTS context_entries (
    title   VARCHAR(255) PRIMARY KEY,
    content TEXT NOT NULL
);
```

> Note: production `config.ts` uses database **`yasmin`** on `192.168.0.2:3307`, user `yasmin` (password from env). Align all examples to that; do not reintroduce `yasmin_ai` / `localhost` from earlier drafts.

### 2.2 New — `memory_archive` (single versioned backup table)

One append-only, versioned table. **Latest version = current.** There is deliberately no separate "current" table and no `is_current` flag (v2 had both `knowledge_files` and a changelog with `is_current`, giving two "current" copies that could drift).

```sql
CREATE TABLE IF NOT EXISTS memory_archive (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  file_path      VARCHAR(255) NOT NULL     COMMENT 'Mistral path, e.g. people/christopher.md',
  content        MEDIUMTEXT   NOT NULL     COMMENT 'Verbose content at this version',
  content_hash   CHAR(64)     NOT NULL     COMMENT 'SHA-256 of content, for change detection',
  version        INT          NOT NULL     COMMENT 'Monotonic per file_path',
  mistral_doc_id VARCHAR(64)  NULL         COMMENT 'Document id returned by Mistral upload',
  created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uk_path_version (file_path, version),
  INDEX idx_path (file_path)
);
-- "Current" = row with MAX(version) for a file_path (expose via a view if convenient).
```

Design notes:

- **`MEDIUMTEXT`, not `TEXT`.** Verbose profiles grow over time; `TEXT`'s 64 KB ceiling is a real risk for permanently-retained, full-replacement content.
- **`mistral_doc_id`** lets recovery/updates delete-then-reupload if Mistral does not overwrite by filename (see §5, verify item).
- **Change detection built in:** skip writing a new version (and skip the Mistral upload) when `content_hash` matches the current version — avoids nightly churn on unchanged files.
- **Retention:** prune to the last N versions per `file_path` (default 10) in Phase 7. Keep **≥2** so a bad update is always reversible.

### 2.3 New — `nightly_job_log`

```sql
CREATE TABLE IF NOT EXISTS nightly_job_log (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  started_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at            TIMESTAMP NULL,
  status                  ENUM('running','completed','failed','partial') NOT NULL DEFAULT 'running',
  last_completed_phase    VARCHAR(32) NULL,
  processed_conversation_ids JSON NULL   COMMENT 'Working set — enables deterministic resume',
  error_message           TEXT NULL,
  conversations_processed INT DEFAULT 0,
  files_updated           INT DEFAULT 0,
  files_created           INT DEFAULT 0
);
```

Two deliberate changes from v2's version:

- **`processed_conversation_ids`** persists the working set. v2 kept it "in memory," so a crash lost which conversations were in scope and made the "resume from Phase N" recovery impossible.
- **`last_completed_phase`** as a single string instead of a `phases_completed` JSON whose key names disagreed with the code (`phase1..5` vs `phase3Point5`…).

The **last successful `completed_at`** is the watermark for the next run's collection window (see §4, Phase 1) — replacing v2's fixed 24-hour filter, which double-processed on overlap and never processed anything a failed run had missed.

---

## 3. File & naming conventions

### 3.1 Reconcile naming first (existing drift)

The repo currently has **three** naming schemes; pick one before implementing:

| Source                                                          | Scheme                                                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/**` code + `mistral_config/conversation/system_prompt.txt` | `Profile of X`, `Session with X`, `Journal with X`, `Family notes`, `Profile of Yasmin` |
| `docs/CONTEXT_CONVENTIONS.md`                                   | `Background on X`, `Interests of X`, `Topics for X`                                     |
| v1/v2 concepts                                                  | `people/x.md`, `journals/…`, `general/…`, `self-reflection/profile.md`                  |

**Recommendation:** for `context_entries`, keep the code's `Profile of X` / `Family notes` / `Profile of Yasmin` titles (**`Session with X` and `Journal with X` are retired** — see banner), and use the **path scheme only inside the Mistral library** (verbose long-term). Update `docs/CONTEXT_CONVENTIONS.md` to match, and define the mapping in §3.3.

### 3.2 Mistral library layout (verbose long-term)

```
people/<name>.md              full profile + history        (overwrite)
self-reflection/profile.md    Yasmin's self-concept         (overwrite)
general/<topic>.md            topical knowledge             (overwrite)
journals/<user>/<conv_id>.md  one summary per conversation  (append-only, never overwrite)
```

### 3.3 Path → eager-title mapping (for the regeneration phase)

| Mistral path                 | `context_entries` title                                                                                           | Transform                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `people/christopher.md`      | `Profile of Christopher`                                                                                          | compress + strip `[PRIVACY:SENSITIVE]` |
| `self-reflection/profile.md` | `Profile of Yasmin`                                                                                               | compress                               |
| `journals/*`                 | _(retired — no eager journal entry; deep history via Mistral RAG, short-term arc in Profile's Recent Happenings)_ | —                                      |
| `general/*`                  | _(not eager by default; semantic recall only)_                                                                    | —                                      |

> The eager cache stays small and sensitive-free. `general/*` topics are intentionally **not** eager-loaded — they are exactly what semantic recall is for.

---

## 4. Nightly Pipeline

Runs at **03:00** daily. Guiding principle unchanged from v2: **conversations are deleted only after everything is durably persisted.**

```
1 Collect ──► 2 Journal ──► 3 Integrate ──► 3.5 Validate ──► 4 Archive(MariaDB)
                                                                    │
   5 Mistral upload ◄──────────────────────────────────────────────┘
        │
        ▼
   6 Regenerate context_entries ──► 7 Cleanup + prune
```

Ordering rationale: **MariaDB archive (4) is committed before the Mistral upload (5)**, so a crash leaves MariaDB ahead and recovery simply re-pushes. The eager-cache regeneration (6) is derived from the just-written archive.

| Phase        | Action                                                                                                        | On failure                                    | Conversations deleted? |
| ------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------- |
| 1 Collect    | List conversations updated since last success; acquire lock; record working set                               | Retry list (backoff ×3), else abort           | No                     |
| 2 Journal    | Per conversation: summarize → `journals/<user>/<id>.md`                                                       | Skip that conv, log, continue                 | No                     |
| 3 Integrate  | AI reads current verbose memory (from Mistral `text_content`) + today's journals; **stages** proposed updates | Abort (nothing written yet)                   | No                     |
| 3.5 Validate | Reviewer checks staged updates **against today's journals**                                                   | Quarantine offending file(s); apply the rest  | No                     |
| 4 Archive    | Insert new versions into `memory_archive` (one transaction; skip unchanged by hash)                           | Roll back txn; abort                          | No                     |
| 5 Upload     | Upload/overwrite changed files to Mistral; store `mistral_doc_id`                                             | Mark `partial`; schedule re-push from archive | No                     |
| 6 Regenerate | Rebuild compressed, sensitive-free `context_entries` from archive                                             | Mark `partial`; retry (idempotent overwrite)  | No                     |
| 7 Cleanup    | Delete processed conversations; prune archive to last N; mark `completed`                                     | Log; safe to retry (404-tolerant)             | **Yes**                |

### 4.1 Phase 1 — Collect

- Window = `updated_at > (last successful nightly_job_log.completed_at)`, **not** a fixed 24 h. Falls back to 24 h only on first-ever run.
- Persist the resulting conversation IDs to `nightly_job_log.processed_conversation_ids` immediately (enables deterministic resume).
- Acquire a processing lock (see §4.6). Verify the Mistral list response actually exposes a completion/status field before filtering on it — current code (`chat_agent.ts`) never uses one.

### 4.2 Phase 3 — Integrate (the staging fix)

v2 never actually produced the `proposedUpdates` it threaded through later phases: `executeWithToolLoop` returned accumulated _tool results_, and no tool captured "the content I want written." Also §8.1 asked the AI to emit `<updates>` XML **and** call `preview_update` — two conflicting mechanisms.

**v3 uses one mechanism — a staging tool:**

```
Integration tools (read-only w.r.t. real stores; writes are deferred to Phase 4):
  list_long_term_files()            → paths + hashes from memory_archive (current versions)
  get_long_term_file(path)          → full current verbose content via Mistral text_content
                                      (verified byte-exact; memory_archive stays passive)
  read_todays_journals()            → the Phase-2 journals (the evidence base)
  stage_update(path, content, is_new) → append to the run's staged-update list  ← the only writer
```

`stage_update` is the single authoritative source of `proposedUpdates`. The AI reads, decides, and stages; nothing hits the real stores until Phase 4.

### 4.3 Phase 3.5 — Validate (give the reviewer the evidence)

The reviewer's core rule is "every new fact must be supported by today's conversations" — so it **must receive today's journals**, alongside each staged update and its current content. v2 passed only `{update, currentContent}`, making that check impossible.

Changes from v2:

- **Input:** `{ stagedUpdate, currentContent, todaysJournals }`.
- **Granularity:** reject **per file**, not the whole batch. Quarantine the offending file (log + keep its previous version), apply the rest. v2's "reject all + abort job" meant one false positive stalled all consolidation every night indefinitely.
- **Output:** enforce structured JSON via the model's JSON/structured-output mode, not "respond with only JSON" prose.
- Keep the immutable-fact / privacy checks from v2 §3.5 — they were good; only the plumbing was broken.

### 4.4 Phase 5 — Mistral upload

- Upload only files whose hash changed (Phase 4 already computed this).
- **Delete-then-upload (confirmed live, §5):** Mistral has no in-place content update — a same-name upload with changed content creates a _duplicate_ (new id). So Phase 5 deletes the old `mistral_doc_id`, uploads the new file, and persists the returned id into `memory_archive`. Identical content is deduped by hash, so unchanged files (already skipped in Phase 4) never churn.
- Uploads process **asynchronously**; do not block the pipeline on `process_status` reaching `done` (the doc is durably stored on 201; only its searchability lags).
- No custom "throttle." A nightly batch is a handful of files; if rate limits are ever hit, add a simple sequential delay. (v2's "throttle" was actually a broken concurrency limiter — mislabeled "requests/second," and it leaked failed requests into its queue forever.)

### 4.5 Phase 6 — Regenerate eager cache (the restored bridge)

For each mapped file (§3.3): compress the verbose content, strip `[PRIVACY:SENSITIVE]` blocks, map path→title, and `UPDATE context_entries` (idempotent). This is what makes nightly consolidation visible to the live assistant. Compression can be a dedicated small LLM call or deterministic templating — decide in the implementation concept.

### 4.6 Locking & the real race

A single daily cron barely needs job-vs-job locking, but it's cheap: a row in a `processing_lock` table (or `GET_LOCK()` in MariaDB) with a timeout. The job-vs-live-chat race is **eliminated by the read-only-agent decision** — the nightly job is the sole writer of `context_entries`, so there is no concurrent writer.

---

## 5. Mistral API — endpoints & assumptions to verify

| Method  | Endpoint                                              | Purpose                                        | Status                      |
| ------- | ----------------------------------------------------- | ---------------------------------------------- | --------------------------- |
| GET     | `/v1/conversations`                                   | List conversations                             | ✅ used in code             |
| POST    | `/v1/conversations[/{id}]`                            | Create / continue                              | ✅ used in code             |
| DELETE  | `/v1/conversations/{id}`                              | Delete conversation                            | ✅ (204)                    |
| GET     | `/v1/libraries/{id}/documents`                        | List documents (**metadata only** — by design) | ✅                          |
| **GET** | **`/v1/libraries/{id}/documents/{doc}/text_content`** | **Retrieve document content**                  | ✅ **exists (corrects v2)** |
| POST    | `/v1/libraries/{id}/documents`                        | Upload document                                | ✅ (201)                    |
| DELETE  | `/v1/libraries/{id}/documents/{doc}`                  | Delete document                                | ✅ (204)                    |

**Verified live against the Mistral API (2026-07-06):**

1. ✅ **No overwrite** — same name + changed content = a new **duplicate** doc (different id). Identical content is **deduped by hash** (returns the existing doc). → Phase 5 must delete-then-upload with a tracked `mistral_doc_id`. `PUT`/`PATCH` modify _metadata only_.
2. ✅ **`text_content` is byte-exact for `.md`** — YAML frontmatter, `#` headers, `**bold**`, and bullets all round-trip verbatim. → Phase 3 reads full current files faithfully; `memory_archive` can stay passive.
3. ✅ **Document `name` preserves slash paths** — `people/christopher.md` is stored verbatim. → the path is a first-class Mistral key, matching `memory_archive.file_path`.
4. ✅ **Uploads are asynchronous** (`process_status: in_progress → done`) and Mistral **auto-generates a per-doc `summary`** (returned on the list endpoint). → don't block on processing; the auto-summary is a free bonus (could seed `context_entries` compression).

**Still to verify:**

- **Conversation list exposes a completion/status field** for the Phase 1 filter (current `chat_agent.ts` never uses one).

**Live-created artifact:** empty production library **`yasmin-memory`** = `019f36d6-630d-74c0-a4e6-8c8d3502ba44` (0 documents). ⚠️ Created under the workspace tied to the _temporary_ test key; confirm it is reachable with the **production** API key before building on this id (recreate under the prod workspace if not).

### Environment / config

- Align to `src/config.ts`: DB `yasmin` @ `192.168.0.2:3307`, user `yasmin`, `DB_PASSWORD` from env. `MISTRAL_API_KEY`, `AGENT_ID`, `YASMIN_LIBRARY_ID` as today.
- Mistral API keys are not `sk_…` (that's an OpenAI convention) — don't use that placeholder.

---

## 6. Reflection trigger & agents

- If reflection reuses the conversation agent's prompt, the `[REFLECTION_TRIGGER]` mode-switch must be added to `mistral_config/conversation/system_prompt.txt` — a prompt currently tuned hard for short, plain-text, first-person, youth-language chat. **Validate the mode switch actually works** before building on it; mode confusion is a real risk.
- A **dedicated `yasmin-nightly` agent** with its own prompt owns Phases 2–3 (library wiring optional — see §1.2). Decide one owner per phase; v2 mixed "same conversation" (Phase 2) with "new conversation" (Phase 3) without saying which agent ran which. Note Phase 2 must reach a conversation's messages — either summarize _inside_ that conversation, or pull them via `GET /v1/conversations/{id}/messages` and feed the nightly agent.
- Drop the "reuse prompt cache" justification for Phase 2 — caches are minutes-lived; at 03:00 there is nothing warm to reuse.

---

## 7. Privacy

Unchanged intent, with the leak paths closed:

- `context_entries` (eager, prepended to every prompt) **must be sensitive-free** — Phase 6 strips `[PRIVACY:SENSITIVE]` during regeneration.
- Verbose Mistral entries **may** contain sensitive blocks — but since Mistral semantic search can surface them, the retrieval/answer layer must honour the "sensitive = direct-answer-only, never proactive/creative" rule. Decide in the implementation concept whether sensitive content is excluded from the searchable library entirely or filtered at answer time.
- Keep v2's privacy checks in the Phase 3.5 reviewer (preserve markers, don't move sensitive text into non-sensitive sections).

---

## 8. Recovery (aligned to the passive backup)

| Failure                 | Recovery                                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mistral lost/corrupted  | Re-push current versions from `memory_archive` (MariaDB is authoritative).                                                                                                                                             |
| Bad AI update to a file | Restore a **chosen prior version** from `memory_archive` (keep ≥2), then re-push to Mistral and re-run Phase 6 for that file. **Not** "restore latest" — latest is the bad one.                                        |
| Crash mid-run           | Read `nightly_job_log.last_completed_phase` + `processed_conversation_ids`; resume from the next phase. All write phases are idempotent (hash-guarded archive, overwrite upload, `UPDATE` cache, 404-tolerant delete). |
| MariaDB down            | Nightly job pauses/retries; conversation agent keeps serving from whatever it last eager-loaded. Restore from `mysqldump`.                                                                                             |

**Backups:** a nightly `mysqldump` of `context_entries` + `memory_archive` before the run covers the catastrophic case simply. Heavy alerting/health-endpoint machinery from v2 §10 is optional for a single-family deployment — right-size it.

---

## 9. What changed from v2 (and why)

| v2                                                     | v3                                                                 | Reason                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Mistral "cannot return content"                        | Mistral `text_content` returns content                             | Factually corrected; unblocks reading verbose memory back                                      |
| MariaDB `knowledge_files` = source of truth            | Mistral = long-term memory; MariaDB = eager cache + passive backup | Restores semantic search as the point of Mistral; matches the intended two-level model         |
| `knowledge_files` (current) + changelog (`is_current`) | one versioned `memory_archive`                                     | Removes dual "current" copies that could drift                                                 |
| Eager cache "regenerated" but no phase did it          | Phase 6 explicitly regenerates `context_entries`                   | Restores the bridge v1 had and v2 lost; without it consolidation is invisible to the assistant |
| `proposedUpdates` never actually produced              | single `stage_update` tool                                         | Fixes the broken Phase 3→4 hand-off                                                            |
| Reviewer lacked the evidence it checks against         | reviewer receives today's journals; per-file quarantine            | Makes the evidence rule enforceable; removes all-or-nothing stall                              |
| Backup = copy of new content (no rollback)             | versioned archive; recovery restores a chosen prior version        | Actually enables rollback of a bad write                                                       |
| Fixed 24 h window                                      | since-last-success watermark                                       | No double/never-processing                                                                     |
| Working set kept in memory                             | persisted in `nightly_job_log`                                     | Deterministic resume                                                                           |
| Broken "throttle" (concurrency limiter, leaks)         | none (add simple delay only if needed)                             | Removes buggy, unneeded machinery                                                              |
| `TEXT` (64 KB)                                         | `MEDIUMTEXT` + change-detection + pruning                          | Bounds growth                                                                                  |
| Write-only Mistral "sync cache"                        | Mistral read via agent RAG (decision flagged)                      | A store with no reader is deferred, not pretended                                              |

**Nits fixed:** `connaissance_files`→`memory_archive` typo; `TIMESTDIFF`→`TIMESTAMPDIFF`; `new Date().toISODate()` (Luxon-only) removed; `phases_completed` key-name mismatch; `sk_…` key placeholder; DB name `yasmin_ai`/`localhost`→`yasmin`@`192.168.0.2`.

---

## 10. Open questions for the implementation concept

All resolved — see `nightly_memory_processing_implementation.md` §14:

1. ✅ **Mistral read path** — conversation agent RAG (console-wired); Phase 3 reads full files from `memory_archive`; nightly RAG optional.
2. ✅ **Compression (Phase 6)** — LLM compaction to the 5-section template, 2 KB cap (Mistral's auto-summary as a candidate input).
3. ✅ **Sensitive content** — kept in the library with answer-time enforcement; always stripped from the eager cache; shared-RAG residual risk accepted; gated per-person recall is future hardening.
4. ✅ **Reflection ownership** — `yasmin-nightly` owns Phases 2–3; Phase 2 pulls transcripts via `GET /conversations/{id}/messages`.
5. ✅ **Live-vs-nightly write race** — eliminated: nightly is the sole writer; the live agent is read-only.
6. ✅ **Journals in the eager cache** — none; per-conversation journals in Mistral (RAG) + Profile's Recent Happenings.

---

_Supersedes `nightly_memory_processing_concept_v2.md`. Status: concept, ready to turn into an implementation concept once §10 is decided._
