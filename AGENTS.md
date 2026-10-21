# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Yasmin AI** - An AI assistant API for thomsen.in that integrates with Synology Chat and the Mistral AI API.

This is a TypeScript/Node.js Express application that provides a chatbot interface between Synology Chat and Mistral's LLM API. It handles three types of chat interactions: bot chats, slash commands (`/yasmin`), and group chats.

## Code Architecture

### Source Structure

```
database/
├── schema.sql             # Database schema for the 2-column context model (context_entries)
└── schema_memory.sql      # Additive schema for the nightly memory job: memory_archive,
                            #   nightly_job_log, processing_lock (does not touch context_entries)
                            #   intraday_notes (cross-person note outbox) lives in schema.sql
mistral_config/
├── conversation/                       # Live conversation agent
│   ├── system_prompt.txt
│   └── functions/
│       ├── read_context_entry.json     # Lazy-load a context entry (read-only)
│       └── share_note.json              # Stage a note for another person (cross-person outbox)
├── summarizer/                         # Restart-handoff summarizer agent (Studio)
│   └── system_prompt.txt
├── dream/                              # Nightly dream agent (weaves old journals into a dream)
│   └── system_prompt.txt
└── nightly/                            # Nightly memory-consolidation agent
    ├── nightly_system_prompt.txt
    ├── prompts/                          # Phase prompt templates (journal, integrate, review, compact);
    │                                     #   rendered by src/nightly/prompts.ts with {{token}} interpolation
    └── functions/
        ├── get_long_term_file.json     # Read one verbose memory file
        ├── list_long_term_files.json   # List verbose memory files
        ├── read_todays_journals.json   # Read today's per-conversation journals
        └── stage_update.json           # Stage a proposed file update for review
scripts/
├── manage-context.ts     # CLI administration utility for context CRUD
└── bootstrap-memory.ts   # One-time migration: seeds memory_archive + the Mistral library from
                          #   the existing context_entries rows (must run before the nightly job)
src/
├── app.ts              # Express server entry point with route handlers
├── chat_agent.ts       # Mistral AI API client - manages conversations & dynamic context
├── handoff.ts          # Summary + last turns handed to a fresh conversation after a restart
├── strings.ts          # Shared string utilities (name slugs, capitalize variants, profile-title
│                       #   builder) - single source of truth for the people/<stem>.md <-> "Profile
│                       #   of X" mapping, used by both the live agent and the nightly pipeline
├── synology_client.ts  # Synology Chat API client - formats and sends responses
├── database/
│   ├── connection.ts   # Connection pooling and execution with retry logic
│   └── models/
│       ├── context.model.ts         # Context model query methods
│       ├── intraday_notes.model.ts  # Cross-person note outbox (intraday_notes): staging, fetch-for-delivery,
│       │                            #   claim/release-claim lifecycle, nightly reset (docs/intraday_notes_deployment.md)
│       ├── memory_archive.model.ts  # Versioned verbose memory file storage (memory_archive)
│       └── nightly_job.model.ts     # Nightly job log, resumable-run watermark, and locking
├── mistral/
│   └── mistral_api.ts  # Low-level Mistral HTTP client (conversations, documents, library),
│                       #   used by the nightly pipeline; retry + pagination handling
├── nightly/
│   ├── run.ts         # CLI entry point (run via ts-node from source); manual runs + --dry-run
│   ├── scheduler.ts   # In-process daily scheduler; started from app.ts, calls the same pipeline
│   ├── pipeline.ts    # 9-phase orchestrator: collect, journal, integrate, review/archive,
│   │                  #   dream, upload, regenerate eager cache, pending-notes reset, cleanup
│   ├── reflection.ts  # Prompts + nightly-agent calls (journal, integrate, review, compact)
│   ├── tools.ts       # Nightly agent's tool set (list/get_long_term_file, read_todays_journals,
│   │                  #   stage_update)
│   ├── privacy.ts     # [PRIVACY:SENSITIVE] stripping + eager-cache compaction size cap
│   ├── dream.ts       # Dream phase (2-3x/week): 2-3 random old journals -> dream agent ->
│   │                  #   reflection with Yasmin's conversation persona (journals/dreams/<date>.md
│   │                  #   + append-only self-reflection/dreams.md)
│   ├── mood.ts        # Yasmin's daily mood: header parse/render, deterministic exponential decay,
│   │                  #   (a fully faded mood also drops its narrative), and the archive stamp that
│   │                  #   overrides the agent's updatedAt
│   └── mapping.ts     # Table-driven mapping between verbose file paths and context_entries titles
├── services/
│   └── context.service.ts    # Orchestrates matching, DB loading, and XML formatting
└── __tests__/
    ├── app.test.ts
    ├── chat_agent.test.ts
    ├── synology_client.test.ts
    ├── database.test.ts
    ├── intraday_notes.model.test.ts
    ├── context.test.ts
    ├── handoff.test.ts
    ├── strings.test.ts
    └── ...                # plus nightly-pipeline suites: mistral_api, nightly_job.model,
                            #   memory_archive.model, mapping, nightly_tools, reflection, privacy,
                            #   pipeline.integration, context.model, bootstrap-memory, mood
```

### Data Flow

1. **Incoming Request** → Synology Chat sends a webhook to `/chat/bot`, `/chat/slash`, or `/chat/group`
2. **Authentication** → Each endpoint validates its respective token (`CHAT_TOKEN_BOT`, `CHAT_TOKEN_SLASH`, `CHAT_TOKEN_GROUP`)
3. **Processing & Matching** → `ChatAgent` invokes `ContextService` on _every turn_ of the conversation.
   - Mandatorily fetches the sender's profile (e.g. `Profile of Zara`), `Family notes`, and `Profile of Yasmin` on the initial turn.
   - Filters out already loaded titles using the session's active conversation cache.
   - Wraps newly loaded context pieces in structured XML tags (`<context_entry title="...">...</context_entry>`) and prepends them to the prompt.
   - Calls the Mistral API with custom Tool Calling configuration and manages 12-hour session state.
4. **Formatting** → `SynologyClient` strips markdown formatting (bold, headers) and chunks long responses (>1800 chars) for Synology's limits
5. **Response** → Answers are sent back to Synology Chat via its API

#### Memory writes: the live agent is read-only (memory)

The nightly job is the **sole writer** of `context_entries`. `ChatAgent` only ever _reads_ them:

- There is no `update_context_entry` tool in the live agent. A stray call to it (for example from a stale
  agent definition in Mistral Studio) is answered with an error result instead of being executed.
  `read_context_entry` lazy-loads other `Profile of X` entries; titles already injected into the current
  conversation are not returned a second time.
- `ContextService`'s eager-loaded set is just `Profile of [sender]` + `Profile of Yasmin` + `Family notes`.
  There are no `Session with X` / `Journal with X` entries in the data model.
- `mistral_config/conversation/system_prompt.txt` tells the agent that deeper facts and conversation history
  from earlier days can be searched via the agent's attached Mistral library (`document_library` tool; the
  model decides when to search, no application code involved). Conversations from the current day are not in
  the library yet.

#### Cross-person notes: the intraday_notes cache

Besides reading memory, the live agent can stage a **note for another person** via `share_note`
(`mistral_config/conversation/functions/share_note.json`; the tool must also be registered on the
Studio conversation agent). Notes are rows in `intraday_notes` (part of `database/schema.sql` --
apply it before deploying), never `context_entries`: the table is an **intraday cache**, not a
memory store -- it holds a note only until it is delivered with the recipient's next user input
or until the nightly job consolidates and resets it. `to` is `"everyone"`, a single first name,
or a list of first names (one row per recipient). Delivery happens **exactly once per
recipient** with the recipient's next user input, injected as a `<nachrichten_fuer_dich>` block
into the prompt; a note is never played back to its own sender (`from_username != ?`). Delivery is guarded by a claim/
release-claim lifecycle (`claimNoteDelivery` / `releaseNoteDelivery` in
`src/database/models/intraday_notes.model.ts`): a note is claimed just before the conversation
request and the claim is rolled back if that request fails, so a failed delivery does not lose the
note. The privacy barrier lives only in the live agent's prompt: never relay anything
confidential or `[PRIVACY:SENSITIVE]`-related. Deployment checklist: `docs/intraday_notes_deployment.md`. The nightly job feeds still-undelivered notes to
the integrate agent and into the review/revision evidence as well, and then empties the outbox (only after phases 3+4 succeeded, and
only up to the snapshot's max id, so concurrently inserted notes survive for the next run).

#### Conversation restarts and the handoff

A live conversation is replaced by a fresh one when it reaches `MAX_TURNS_PER_SESSION` user turns (Mistral
reprocesses the full history every turn, so latency grows) and when a conversation turns out to be gone or
broken (HTTP 404/400, or a failed tool request). The old conversation is left for the nightly job to journal
and delete. So the new one does not start blind, its first prompt carries a `<previous_conversation>` block
(`src/handoff.ts`):

- `<summary>`: a short summary of the older turns, written by a dedicated Mistral Studio agent
  (`AGENT_ID_SUMMARIZER`, prompt in `mistral_config/summarizer/system_prompt.txt`) called with
  `store: false`; the throwaway conversation it creates is deleted right after. The previous summary is fed
  into the next one, so chained restarts keep the thread.
- `<recent_messages>`: the last 3 turns, verbatim (user text without the injected context entries, capped
  per message).
- The summary is built in the background right after the turn that exhausts the budget. The next turn waits
  up to 5 seconds for it and otherwise goes with the recent messages only. Without `AGENT_ID_SUMMARIZER`, or
  when the summarizer fails, the handoff degrades to recent messages (and the previous summary, if any); it
  never blocks or fails the user's message.
- Context entries are _not_ part of the handoff: the fresh conversation gets the sender's profile, family
  notes and Yasmin's profile again as on any first turn.
- The nightly journal strips the block (`stripHandoffBlock` in `src/nightly/reflection.ts`), because the old
  conversation is journaled on its own.

### Key Classes & Services

- **`ChatAgent`** (`src/chat_agent.ts`): Core LLM integration. Manages conversation lifecycle (create/new), dynamically tracks `loadedContextTitles` per active session, formats/prepends static context, and executes sequential Tool Calling loops for lazy-loading. Read-only for memory (see above); on a restart it prepends the handoff block built by `src/handoff.ts`.
- **`ContextService`** (`src/services/context.service.ts`): Handles loading matching documents, loading mandatory static grounding entries, filtering out duplicates, and formatting them into XML.
- **`MistralApi`** (`src/mistral/mistral_api.ts`): Low-level Mistral HTTP client (conversations, documents, library) with retry/pagination, used by the nightly pipeline and by the handoff (`src/handoff.ts`: reading the old conversation, the one-shot summarizer call) — separate from `ChatAgent`'s own inline `fetch` calls for the live conversation.
- **Nightly pipeline** (`src/nightly/`): `pipeline.ts` orchestrates the nightly consolidation run; `reflection.ts` holds the agent calls for journaling, integrating, reviewing, and compacting, building its prompts from the templates in `mistral_config/nightly/prompts/` (rendered by `src/nightly/prompts.ts`); `mood.ts` implements Yasmin's daily mood layer (`self-reflection/mood.md`): the machine-readable header, deterministic exponential decay toward neutral (run nightly before the upload phase, no agent call), the archive stamp that overrides the agent-supplied `updatedAt`, and the privacy-guarded fold-in of the current mood into the compacted `Profile of Yasmin`; `tools.ts` implements the nightly agent's tool-calling surface; `privacy.ts` strips `[PRIVACY:SENSITIVE]` content and enforces the eager-cache size cap; `mapping.ts` maps verbose file paths (e.g. `people/christopher.md`) to `context_entries` titles (e.g. `Profile of Christopher`) and back, using the shared stem/capitalize helpers in `src/strings.ts` (the same function the pipeline's journal-path builder uses, so both mapping directions cannot drift apart) -- `topics/` files, `general/topic-index.md`, and `self-reflection/mood.md` deliberately have NO eager mapping (RAG via the Mistral library upload only, never in the turn-1 prompt); `run.ts` is the CLI entry point (run via ts-node from source).

### Nightly Memory Pipeline

Once a night, an in-process scheduler (`src/nightly/scheduler.ts`, started from `app.ts`) calls the same
pipeline the API server is already running in — no external cron daemon or wrapper script, so it always
has the exact same environment/config as the server. (`src/nightly/run.ts`, run via ts-node from source,
remains available for a manual one-off run or `--dry-run` preflight check; see
`docs/nightly_memory_processing_implementation.md` §11.) This runs entirely offline from the request/response path above — it
consolidates the day's Synology conversations into long-term memory after the fact.

At a high level, each run:

1. **Collects** every conversation the live agent (`AGENT_ID_CONVERSATION`) has had since the last successful watermark.
   If the collected batch is empty — fresh **or** resumed — and the `intraday_notes` outbox holds no undelivered
   notes, the run **short-circuits** right there: it records a `completed` job row with `conversationsProcessed: 0`,
   advances the watermark, releases the lock, and skips phases 2-9 entirely (no LLM calls, no Mistral writes or
   deletes). A non-empty outbox keeps the consolidation path running even with zero conversations, so undelivered
   notes are never stranded by the skip. The skip also fires when the outbox state is unknown because reading it
   failed (`getUnconsolidatedNotes` threw): the skip performs no outbox writes, so any pending notes stay in the
   outbox untouched and are picked up by the next run. The skip never reaches the outbox reset (Phase 8), so
   already-delivered notes can linger across consecutive quiet nights; they are inert (delivery and consolidation
   only ever look at rows with `delivered_at IS NULL`) and are cleared by the next non-skipped run's bounded
   delete.
2. **Journals** each conversation into a per-conversation markdown summary.
3. **Integrates** today's journals into proposed updates to a small set of verbose long-term memory files
   (`people/<name>.md`, `self-reflection/profile.md`, `general/family.md`, `topics/<topic>.md`, `general/topic-index.md`), using a dedicated nightly Mistral
   agent (`AGENT_ID_NIGHTLY`) and its own tool-calling surface (`src/nightly/tools.ts`).
4. **Reviews** each proposed update against the day's evidence, then **archives** accepted versions as new
   rows in MariaDB's `memory_archive` table — a versioned, verbose local backup (may contain
   `[PRIVACY:SENSITIVE]` markers) that is the durable source of truth for the pipeline itself.
5. **Dreams** (2-3x per week, randomly cadenced): a dedicated dream agent weaves 2-3 random OLD
   privacy-stripped journals into a dream (archived to `journals/dreams/<date>.md`, RAG-searchable),
   which Yasmin's conversation persona then reflects on herself; the dated reflection is appended to the
   append-only `self-reflection/dreams.md`. Resumable like every phase: no double dream, no duplicated
   reflection after a crash between the two stages.
6. **Uploads** changed files, with `[PRIVACY:SENSITIVE]` content already stripped, to a Mistral knowledge
   library (`MISTRAL_LIBRARY_ID`) that the live conversation agent can search via RAG for deeper facts and
   history, and deletes any orphaned library documents. Sensitive passages never leave local storage —
   `memory_archive` keeps the full content for versioning/audit, but nothing marked sensitive is ever sent
   to the third-party Mistral API for RAG. (Exception: the nightly agent's own review/revision calls do
   see the unstripped archive content — privacy stripping applies to the library upload, not to the
   pipeline-internal LLM calls; those run with `store: false` and their scratch conversations are
   deleted.)
7. **Regenerates the `context_entries` eager cache**: compacts and privacy-strips the current verbose files
   and upserts them back into MariaDB's `context_entries` — the same table the live agent reads on turn 1 —
   so the small, fast, sensitive-free eager set always reflects the latest long-term memory.
8. **Resets the pending-notes outbox** (after consolidation succeeded, the day's intraday notes have
   served their purpose).
9. **Cleans up**: deletes the now-processed Mistral conversations and prunes old `memory_archive` versions
   and `nightly_job_log` rows.

The job is resumable and self-locking (`processing_lock`, `nightly_job_log`), and can be smoke-tested
without writing anything via `npm run nightly:dry-run`. Before the job is ever enabled, `scripts/bootstrap-memory.ts`
must be run once to seed `memory_archive` and the Mistral library from the _existing_ `context_entries`
rows — otherwise the first real run would see an empty verbose store and wipe the live profiles when it
regenerates the eager cache. See `docs/nightly_memory_processing_implementation.md` for the full design.

## Development Commands

| Command                                    | Description                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `npm start` or `npm run s`                 | Start development server with nodemon                                                                 |
| `npm test`                                 | Run all Jest tests                                                                                    |
| `npm run test -- --testPathPattern=<file>` | Run a single test file                                                                                |
| `npm run test -- --testNamePattern=<name>` | Run tests matching a name pattern                                                                     |
| `npm run lint`                             | Run ESLint on source files                                                                            |
| `npm run format`                           | Format all files with Prettier                                                                        |
| `npm run check`                            | Run both format and lint                                                                              |
| `npm run manage-context <command>`         | Run context administration commands (list, create...)                                                 |
| `npm run nightly`                          | Run the nightly memory-consolidation job once (via ts-node, no build needed)                          |
| `npm run nightly:dry-run`                  | Preflight the nightly job: checks DB + Mistral connectivity and logs what it would do, writes nothing |
| `npm run bootstrap-memory`                 | One-time migration: seed `memory_archive` + the Mistral library from existing `context_entries`       |

## Testing

- Tests use Jest with `ts-jest` preset
- `fetch` is mocked globally for `ChatAgent` tests
- Test files follow pattern `src/__tests__/<module>.test.ts`
- Code coverage includes: XML context injection, connection pool retry logic, conversation management, response parsing, markdown stripping, text chunking, and sequential Tool Calling execution loops

## Build Configuration

- **TypeScript**: `tsconfig.json` with `target: es6`, `module: commonjs`, strict mode enabled
- **ESLint**: Flat config with TypeScript plugin, single quotes, semicolons required
- **Prettier**: 2-space indentation, Unix line endings, 110 char line limit
- **Jest**: Node environment, ts-jest transformer

## Environment Variables

Required for runtime:

- `MISTRAL_API_KEY` - Mistral AI API authentication
- `CHAT_TOKEN_BOT` - Token for `/chat/bot` endpoint
- `CHAT_TOKEN_SLASH` - Token for `/chat/slash` endpoint
- `CHAT_TOKEN_GROUP` - Token for `/chat/group` endpoint
- `AGENT_ID_CONVERSATION` - Mistral agent identifier for the live conversation agent
- `MISTRAL_LIBRARY_ID` - Mistral knowledge library id the nightly job uploads to and the live agent RAGs against
- `AGENT_ID_NIGHTLY` - Mistral agent identifier for the nightly memory-consolidation agent
- `NIGHTLY_MAX_ITERATIONS` - Optional: max tool-loop iterations for the nightly integrate agent (default 25; malformed values fall back to the default)
- `DB_PASSWORD` - Database password (host/user/name are hardcoded in `src/config.ts`)

Required once the nightly job is deployed (see Nightly Memory Pipeline above):

- `MISTRAL_LIBRARY_ID` - Mistral knowledge library id the nightly job uploads to and the live agent's RAG reads from
- `AGENT_ID_NIGHTLY` - Mistral agent identifier for the dedicated nightly memory-consolidation agent
- `MEMORY_TZ` - IANA timezone the nightly job's schedule/watermark are computed in (default `Europe/Berlin`)
- `AGENT_ID_SUMMARIZER` - Optional: Mistral agent that summarizes a conversation for the restart handoff (see above). Without it the handoff carries only the last turns
- `AGENT_ID_DREAM` - Optional: dedicated dream agent for the nightly dream phase (narrative, absurd, non-linear). Without it the dream generation falls back to the nightly agent with a creative prompt
- `NIGHTLY_MAX_RETRIES` - Max retries for Mistral HTTP requests in the nightly pipeline (used by `MistralApi.withRetry` for transient 429/5xx/network errors; default `3`)
- `MAX_TURNS_PER_SESSION` - Turn-based mid-session compaction: once a live conversation reaches this many user turns, it is closed (the nightly job still journals and deletes it) and the next turn starts a fresh conversation, resetting latency. Default `50`. The fresh conversation is seeded with a summary and the last 3 turns of the old one (see Conversation restarts and the handoff).
- `REQUEST_TIMEOUT_MS` - Hard timeout for any single Mistral HTTP call made through `mistral_api.ts` (live turns and the nightly pipeline alike; default `120000`, clamped to [1, 600000], unparseable values fall back to the default).

## API Endpoints

| Method | Endpoint      | Description                                              |
| ------ | ------------- | -------------------------------------------------------- |
| POST   | `/chat/bot`   | handles bot chat messages (async response via webhook)   |
| POST   | `/chat/slash` | handles `/yasmin` slash commands ( synchronous response) |
| POST   | `/chat/group` | handles group chat messages (synchronous response)       |
| GET    | `/test`       | Health check endpoint                                    |

## Code Style

- Single quotes for strings
- Semicolons required
- 2-space indentation
- Unix line endings
- TypeScript strict mode
- Prefer arrow functions

### Comment convention

- **Unit comments**: every function, class, and arrow-function constant gets a TSDoc block
  (`/** ... */`) directly above it, interfaces and types too when they carry a behavior contract.
  One concise sentence about what the unit does, elaboration only if needed, plus `@param`,
  `@returns` and `@throws` as applicable. Trivial private helpers still get a one-line block.
- **Inline comments**: brief, single-purpose `//` hints explaining _why_ something non-obvious is
  done. No multi-paragraph essays: anything longer than ~3 lines belongs in the unit comment (or the
  referenced design doc) instead.
- Enforcement: `jsdoc/require-jsdoc` (eslint-plugin-jsdoc) fails `npm run lint` on any undocumented
  function/class in `src/` and `scripts/`. Test files in `src/__tests__/` are exempt; comment test
  scaffolding only where behavior is genuinely non-obvious.
