# Context Conventions

This document outlines the naming conventions and architectural separation between **Static Context** and
**Dynamic Context** in Yasmin AI's knowledge base, plus the deeper long-term memory tier introduced by the
nightly memory processing job.

> **Note:** this document describes the naming actually implemented in `src/database/db_proxy.ts` and
> `database/schema.sql` (`Profile of X` / `Family notes`, etc.). An earlier draft of this document described
> an aspirational `Background on X` / `Interests of X` / `Topics for X` scheme that was never implemented —
> ignore any references to that scheme elsewhere.

---

## 1. Context Groups Overview

The assistant's context is separated into two groups within MariaDB's `context_entries` table, to achieve
high accuracy, minimize token bloat, and avoid cross-language keyword mismatch:

```
                      ┌────────────────────────────────────────┐
                      │             Context System             │
                      │        (MariaDB `context_entries`)      │
                      └───────────────────┬────────────────────┘
                                          │
                  ┌───────────────────────┴───────────────────────┐
                  ▼                                               ▼
      ┌───────────────────────┐                       ┌───────────────────────┐
      │  Eager Group          │                       │  Lazy Group           │
      │  (Eagerly Loaded)     │                       │  (Tool-Called/Lazy)   │
      └───────────┬───────────┘                       └───────────┬───────────┘
                  │                                               │
      ┌───────────┼───────────────┬───────────┐                   ▼
      ▼           ▼               ▼           ▼            Profile of [Person]
   Profile     Family          Profile    Session with     (any person other than
   of Yasmin   notes           of         [Sender] ⚠️        the current sender)
                               [Sender]    phased out,
                                           see §2.1
```

Beyond this table, a third, deeper tier — the **Mistral knowledge library** plus its local
`memory_archive` backup — holds the full verbose, long-term memory that `context_entries` is compacted
from. See §4.

---

## 2. Eager Group (Eagerly Loaded)

These entries are loaded into the system prompt on the initial turn of every conversation, in a single
batch, via `ContextService`/`ChatAgent`.

### Naming Pattern

- Two fixed titles: **`Profile of Yasmin`** and **`Family notes`**.
- One per-sender title: **`Profile of [Sender]`** (case-insensitive), for whoever Yasmin is currently
  talking to.

### Eager Entries List

| Title                       | Description / Content                                                                                                                 | Loading Behavior                                                                |
| :-------------------------- | :------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------ |
| **`Profile of Yasmin`**     | Yasmin's own identity, personality, preferences and interests, written in first person.                                               | Mandatory on the initial turn.                                                  |
| **`Family notes`**          | Family-wide notes: traditions, inside jokes, shared rules.                                                                            | Mandatory on the initial turn.                                                  |
| **`Profile of [Sender]`**   | Everything known about the person Yasmin is currently talking to: facts, preferences, relationship, communication style, open topics. | Mandatory on the initial turn.                                                  |
| **`Session with [Sender]`** | Topics to bring up and questions Yasmin wants to ask this sender next.                                                                | Mandatory on the initial turn — **only until the read-only cutover, see §2.1.** |

### 2.1 `Session with [Sender]` is being phased out

`Session with [Sender]` is only eagerly loaded today because the live conversation agent is still allowed
to write to `context_entries` directly (via the `update_context_entry` tool). A separate, already-built
"read-only cutover" commit on the `feature/nightly-memory-processing` branch removes it from the eager set
once the nightly memory job (§4) has been verified in production over several nights. After that cutover:

- `context_entries` is eagerly loaded as just `Profile of [sender]` + `Profile of Yasmin` + `Family notes`.
- Proactive topics/questions live inside `Profile of [Sender]` instead of a separate entry (folded in by the
  nightly pipeline's compaction step).
- Stale `Session with X` and `Journal with X` rows (see §3) are left in `context_entries` harmlessly — empty
  content, no longer read or written by anything — pending a manual cleanup pass.

---

## 3. Lazy Group (On-Demand / Lazy Loaded)

Any `context_entries` row not in the eager set can be fetched on demand by Yasmin herself via Mistral Tool
Calling (`read_context_entry`). In practice this is exactly one pattern:

### Naming Pattern

- **`Profile of [Person]`** — the profile of anyone other than the current sender (e.g. a sibling or
  grandparent who comes up in conversation).

Since Yasmin understands German, if a German user asks _"Was macht Zara gerade?"_, Yasmin can decide to
call `read_context_entry` with `title="Profile of Zara"` without any language-specific matching logic.

> **Legacy rows:** `context_entries` also still contains `Session with X` (for non-sender family members)
> and `Journal with X` rows, seeded with empty content from the start. Nothing in this feature populates
> `Journal with X` — real journaling now happens inside the nightly pipeline's own per-conversation journal
> files (`journals/<name>/<conversation-id>.md` in `memory_archive`, not exposed to `context_entries` or the
> Mistral library). These rows show up in the lazy-load manifest but never resolve to anything useful; treat
> them as cruft rather than part of the active naming scheme.

### Tool Definition: `read_context_entry`

- **Description**: Retrieves the content of a context entry from the database based on the exact title.
- **Parameters**:
  - `title` (string): The exact title of the context entry to retrieve (e.g. `Profile of Zara`).

On the initial turn, `ContextService` also injects a manifest (`<available_context_entries>`) listing every
title not already eagerly loaded, so Yasmin knows what she can ask for.

---

## 4. Long-Term Memory Tier (Mistral Knowledge Library)

`context_entries` only ever holds a small, compacted, sensitive-free cache. The nightly memory processing
job (`src/nightly/`, see `AGENTS.md` → "Nightly Memory Pipeline") maintains a much deeper, verbose store
that this cache is regenerated from every night:

```
                 ┌───────────────────────────────────────────────────┐
                 │         Long-Term Memory Tier (regenerated         │
                 │                nightly from conversations)         │
                 │                                                     │
                 │   Mistral library "memory" (semantic search / RAG)  │
                 │   + MariaDB `memory_archive` (versioned local backup)│
                 └───────────────────────┬─────────────────────────────┘
                                         │
                 ┌───────────────────────┼───────────────────────────┐
                 ▼                       ▼                           ▼
        people/<name>.md      self-reflection/profile.md      general/family.md
```

### Files & Their `context_entries` Counterpart

| Path                             | Purpose                                                                                                                                                                             | Regenerates (nightly, compacted + privacy-stripped) |
| :------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------- |
| **`people/<name>.md`**           | Verbose, structured profile per family member/contact: Core Facts, Current Attitude, Ideas/Interests/Goals, Recent Happenings, Open Topics, Communication Style, Yasmin's Intentions. May contain `[PRIVACY:SENSITIVE]` blocks. | `Profile of [Name]`                                 |
| **`self-reflection/profile.md`** | Yasmin's own long-term self-reflection, written in first person.                                                                                                                    | `Profile of Yasmin`                                 |
| **`general/family.md`**          | Family-wide notes: traditions, inside jokes, shared rules.                                                                                                                          | `Family notes`                                      |

(`journals/<name>/<conversation-id>.md` also lives in `memory_archive` as an intermediate artifact of the
nightly pipeline, but has no mapping to a `context_entries` title or the Mistral library — see the legacy-row
note in §3.)

### How it's populated and read

- **Written by:** the nightly job only — every run re-reads that day's conversations, updates the relevant
  verbose files, versions each change in `memory_archive` (MariaDB; the durable source of truth and backup),
  and uploads changed files to the Mistral library.
- **Read by:** the live conversation agent, via the Mistral library's built-in RAG (semantic search) — no
  tool call needed, unlike the eager/lazy `context_entries` groups above.
- **Current status:** as of today (pre-cutover), the library is being populated nightly, but the live
  agent's system prompt has not yet been wired up to mention or rely on it — RAG consumption begins at the
  same read-only cutover described in §2.1, when `mistral_config/system_prompt.txt` is updated to tell the
  agent that deeper facts and past conversations surface automatically from this library.
- **Privacy:** verbose files may contain a `[PRIVACY:SENSITIVE]` marker around sensitive passages. Such
  content is always stripped before it's compacted into the `context_entries` eager cache, but remains in
  the Mistral library itself, gated only by prompt-level enforcement (the library is shared across the whole
  family).

---

## 5. Summary: Which Store Answers Which Question

| Yasmin needs to know...                                       | Source                                                                |
| :------------------------------------------------------------ | :-------------------------------------------------------------------- |
| Who am I, what do I like? / Who is this family?               | `Profile of Yasmin`, `Family notes` (eager)                           |
| Basic facts about the person I'm talking to right now         | `Profile of [Sender]` (eager)                                         |
| Basic facts about someone else who comes up in conversation   | `Profile of [Person]` (lazy, `read_context_entry`)                    |
| A deep, specific memory or something from a past conversation | Mistral library RAG over `people/<name>.md` / journals (post-cutover) |
| The full verbose history / audit trail behind a profile       | `memory_archive` (MariaDB, versioned; nightly job only)               |
