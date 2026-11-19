# Project instructions

Yasmin AI is a TypeScript/Node.js Express API connecting Synology Chat to Mistral. Yasmin is a
persistent, personalized AI companion in a fixed family persona, not a general-purpose chatbot.
The illusion of one continuous person is the product: never expose machinery in chat, and let
optional subsystems degrade quietly without blocking the user's message.

## Invariants

- Memory is identity: the live agent reads memory but never writes `context_entries`; the nightly
  pipeline is the sole application writer, with evidence review and versioned archive. Intraday
  `share_note` rows are a temporary outbox, not memory.
- Keep the eager cache and nightly Mistral library uploads free of `[PRIVACY:SENSITIVE]` passages.
  The local archive retains them; pipeline-internal Mistral review/revision calls can receive unstripped
  content. The one-time bootstrap uploads existing context directly: inspect it for sensitive content
  before running. Cross-person note confidentiality relies on the live agent's prompt.
- Dreams are not facts. Dream-derived material must remain marked as such; the direct dream fold-in
  to Yasmin's profile contains her own reflections as soft evidence. Mood colors her expression,
  not what she knows.
- Before enabling the nightly job on an existing installation, bootstrap the archive and library
  from existing context. Phase 7 does not overwrite entries without a verbose source, but without
  bootstrap the pipeline lacks that existing memory. See `docs/ARCHITECTURE.md` before deployment.

## Where to look

- Read `docs/PROJECT.md` for product semantics and design principles.
- Read `docs/ARCHITECTURE.md` for live request flow, handoff, notes, nightly phases, module map,
  environment variables and operations. Consult it before changing these subsystems; update it when
  their behavior or settings change, keeping these root instructions concise.
- Read `docs/CONTEXT_CONVENTIONS.md` for memory tiers and naming; `docs/intraday_notes_deployment.md`
  for note deployment. `docs/nightly_memory_processing_implementation.md` is a historical design
  document; verify superseded details against the architecture reference and code.
- Key code: `src/app.ts` routes and scheduler startup; `src/chat_agent.ts`, `src/handoff.ts` and
  `src/services/context.service.ts` for live chat; `src/nightly/` for consolidation; `src/database/`
  for persistence; `src/mistral/mistral_api.ts` for Mistral HTTP; `mistral_config/` for prompts/tools.

## Development and verification

| Command                                       | Purpose                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm start` / `npm run s`                     | Start server / start with nodemon                                                            |
| `npm run build`                               | TypeScript build                                                                             |
| `npm test`                                    | Run Jest; use `npm test -- --testPathPattern=<file>` or `--testNamePattern=<name>` to narrow |
| `npm run lint`                                | ESLint on `src` and `scripts`                                                                |
| `npm run format` / `npm run check`            | Format the entire repository / format then lint; both modify files                           |
| `npm run manage-context <command>`            | Context administration; some commands write data                                             |
| `npm run nightly` / `npm run nightly:dry-run` | Run consolidation (writes data) / connectivity preflight (no writes)                         |
| `npm run bootstrap-memory`                    | One-time archive and library seeding; writes data                                            |

Tests use Jest with ts-jest in Node, under `src/__tests__/`; live-agent tests mock `fetch`. TypeScript
is strict, CommonJS, ES6 target. Use single quotes, semicolons, two-space indentation, Unix line
endings and arrow functions where appropriate; Prettier's line limit is 110.
Shared isolated ChatAgent and pipeline fixtures live in `src/__tests__/fixtures/`, excluded from Jest discovery.

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
