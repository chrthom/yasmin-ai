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
mistral_config/
├── system_prompt.txt                   # Live conversation agent's system prompt
├── nightly_system_prompt.txt           # Nightly memory-consolidation agent's system prompt
└── functions/
    ├── read_context_entry.json         # Live agent: lazy-load a context entry
    ├── update_context_entry.json       # Live agent: write a context entry
    │                                   #   (retired at the read-only cutover, see Data Flow below)
    ├── get_long_term_file.json         # Nightly agent: read one verbose memory file
    ├── list_long_term_files.json       # Nightly agent: list verbose memory files
    ├── read_todays_journals.json       # Nightly agent: read today's per-conversation journals
    └── stage_update.json               # Nightly agent: stage a proposed file update for review
scripts/
├── manage-context.ts     # CLI administration utility for context CRUD
├── bootstrap-memory.ts   # One-time migration: seeds memory_archive + the Mistral library from
│                         #   the existing context_entries rows (must run before the nightly job)
└── nightly-memory-job.sh # Cron wrapper: runs dist/nightly/run.js, emails on non-zero exit
src/
├── app.ts              # Express server entry point with route handlers
├── chat_agent.ts       # Mistral AI API client - manages conversations & dynamic context
├── synology_client.ts  # Synology Chat API client - formats and sends responses
├── database/
│   ├── connection.ts   # Connection pooling and execution with retry logic
│   ├── db_proxy.ts     # Database proxy loaded with mock background entries
│   └── models/
│       ├── context.model.ts         # Context model query methods
│       ├── memory_archive.model.ts  # Versioned verbose memory file storage (memory_archive)
│       └── nightly_job.model.ts     # Nightly job log, resumable-run watermark, and locking
├── mistral/
│   └── mistral_api.ts  # Low-level Mistral HTTP client (conversations, documents, library),
│                       #   used by the nightly pipeline; retry + pagination handling
├── nightly/
│   ├── run.ts         # Entry point compiled to dist/nightly/run.js; arg parsing, --dry-run
│   ├── pipeline.ts    # 7-phase orchestrator: collect, journal, integrate, review/archive,
│   │                  #   upload, regenerate eager cache, cleanup
│   ├── reflection.ts  # Prompts + nightly-agent calls (journal, integrate, review, compact)
│   ├── tools.ts       # Nightly agent's tool set (list/get_long_term_file, read_todays_journals,
│   │                  #   stage_update)
│   ├── privacy.ts     # [PRIVACY:SENSITIVE] stripping + eager-cache compaction size cap
│   └── mapping.ts     # Table-driven mapping between verbose file paths and context_entries titles
├── services/
│   └── context.service.ts    # Orchestrates matching, DB loading, and XML formatting
└── __tests__/
    ├── app.test.ts
    ├── chat_agent.test.ts
    ├── synology_client.test.ts
    ├── database.test.ts
    ├── context.test.ts
    └── ...                # plus nightly-pipeline suites: mistral_api, nightly_job.model,
                            #   memory_archive.model, mapping, nightly_tools, reflection, privacy,
                            #   pipeline.integration, context.model, bootstrap-memory
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

#### Memory writes: current vs. pending

**Current (today, on `main`):** `ChatAgent` still both _reads and writes_ `context_entries` directly during
the live conversation, exactly as it did before the nightly memory pipeline existed:

- `read_context_entry` lazily loads any other `Profile of X` entry the agent decides it needs mid-conversation.
- `update_context_entry` lets the agent write new/corrected facts straight into `context_entries` on the spot.
- The nightly pipeline (below) is purely additive today — it writes its own tables (`memory_archive`) and
  the Mistral library, and regenerates `context_entries` from them, but the live agent keeps writing to
  `context_entries` in parallel. Nothing about the live request path changes yet.

**Pending (built, not yet merged):** this feature branch also contains a separate, deliberately unmerged
"read-only cutover" commit (`(M5) read-only cutover`) that must only be merged after the nightly job above
has been verified in production over several nights. Once merged:

- The `update_context_entry` tool handler is removed from `chat_agent.ts` entirely, and its function
  definition (`mistral_config/functions/update_context_entry.json`) is deleted — the live agent becomes
  read-only for memory.
- `ContextService`'s eager-loaded set drops the `Session with [sender]` entry, leaving just
  `Profile of [sender]` + `Profile of Yasmin` + `Family notes`.
- `mistral_config/system_prompt.txt` is rewritten to tell the agent that deeper facts and past conversation
  history now surface automatically via the Mistral library's RAG (no tool call needed), and adds a
  privacy-enforcement rule for `[PRIVACY:SENSITIVE]` content.
- The nightly job becomes the **sole writer** of `context_entries`.

Until that cutover lands, do not remove the live agent's write path — that would leave a gap where nothing
keeps memory fresh.

### Key Classes & Services

- **`ChatAgent`** (`src/chat_agent.ts`): Core LLM integration. Manages conversation lifecycle (create/new), dynamically tracks `loadedContextTitles` per active session, formats/prepends static context, and executes sequential Tool Calling loops for lazy-loading (and, today, for writing memory updates — see Data Flow above).
- **`ContextService`** (`src/services/context.service.ts`): Handles loading matching documents, loading mandatory static grounding entries, filtering out duplicates, and formatting them into XML.
- **`DbProxy`** (`src/database/db_proxy.ts`): Relational database proxy, pre-populated with standard prose Markdown backgrounds.
- **`MistralApi`** (`src/mistral/mistral_api.ts`): Low-level Mistral HTTP client (conversations, documents, library) with retry/pagination, used exclusively by the nightly pipeline — separate from `ChatAgent`'s own inline `fetch` calls.
- **Nightly pipeline** (`src/nightly/`): `pipeline.ts` orchestrates the nightly consolidation run; `reflection.ts` holds the prompts/agent calls for journaling, integrating, reviewing, and compacting; `tools.ts` implements the nightly agent's tool-calling surface; `privacy.ts` strips `[PRIVACY:SENSITIVE]` content and enforces the eager-cache size cap; `mapping.ts` maps verbose file paths (e.g. `people/christopher.md`) to `context_entries` titles (e.g. `Profile of Christopher`) and back; `run.ts` is the CLI entry point compiled to `dist/nightly/run.js`.

### Nightly Memory Pipeline

Once a night, a cron job runs `scripts/nightly-memory-job.sh`, which invokes `node dist/nightly/run.js`
(compiled from `src/nightly/run.ts`). This runs entirely offline from the request/response path above —
it consolidates the day's Synology conversations into long-term memory after the fact.

At a high level, each run:

1. **Collects** every conversation the live agent (`AGENT_ID`) has had since the last successful watermark.
2. **Journals** each conversation into a per-conversation markdown summary.
3. **Integrates** today's journals into proposed updates to a small set of verbose long-term memory files
   (`people/<name>.md`, `self-reflection/profile.md`, `general/family.md`), using a dedicated nightly Mistral
   agent (`AGENT_ID_NIGHTLY`) and its own tool-calling surface (`src/nightly/tools.ts`).
4. **Reviews** each proposed update against the day's evidence, then **archives** accepted versions as new
   rows in MariaDB's `memory_archive` table — a versioned, verbose local backup (may contain
   `[PRIVACY:SENSITIVE]` markers) that is the durable source of truth for the pipeline itself.
5. **Uploads** changed files to a Mistral knowledge library (`MISTRAL_LIBRARY_ID`) that the live conversation
   agent can search via RAG for deeper facts and history, and deletes any orphaned library documents.
6. **Regenerates the `context_entries` eager cache**: compacts and privacy-strips the current verbose files
   and upserts them back into MariaDB's `context_entries` — the same table the live agent reads on turn 1 —
   so the small, fast, sensitive-free eager set always reflects the latest long-term memory.
7. **Cleans up**: deletes the now-processed Mistral conversations and prunes old `memory_archive` versions
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
| `npm run nightly`                          | Run the nightly memory-consolidation job once (requires `npm run build` first)                        |
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
- `AGENT_ID` - Mistral agent identifier
- `DB_HOST` - Database host
- `DB_USER` - Database user
- `DB_PASSWORD` - Database password
- `DB_NAME` - Database name

Required once the nightly job is deployed (see Nightly Memory Pipeline above):

- `MISTRAL_LIBRARY_ID` - Mistral knowledge library id the nightly job uploads to and the (post-cutover) live agent's RAG reads from
- `AGENT_ID_NIGHTLY` - Mistral agent identifier for the dedicated nightly memory-consolidation agent
- `MEMORY_TZ` - IANA timezone the nightly job's schedule/watermark are computed in (default `Europe/Berlin`)
- `NIGHTLY_MAX_RETRIES` - Max retry attempts for a nightly phase before it is skipped/marked failed (default `3`)

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
