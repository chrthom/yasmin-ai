# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Yasmin AI** - An AI assistant API for thomsen.in that integrates with Synology Chat and the Mistral AI API.

This is a TypeScript/Node.js Express application that provides a chatbot interface between Synology Chat and Mistral's LLM API. It handles three types of chat interactions: bot chats, slash commands (`/yasmin`), and group chats.

## Code Architecture

### Source Structure

```
database/
└── schema.sql          # Database schema for the 2-column context model
scripts/
└── manage-context.ts   # CLI administration utility for context CRUD
src/
├── app.ts              # Express server entry point with route handlers
├── chat_agent.ts       # Mistral AI API client - manages conversations & dynamic context
├── synology_client.ts  # Synology Chat API client - formats and sends responses
├── database/
│   ├── connection.ts   # Connection pooling and execution with retry logic
│   ├── db_proxy.ts     # Database proxy loaded with mock background entries
│   └── models/
│       └── context.model.ts  # Context model query methods
├── services/
│   ├── tfidf.service.ts      # Pure TF-IDF tokenization and similarity calculation
│   └── context.service.ts    # Orchestrates matching, DB loading, and XML formatting
└── __tests__/
    ├── app.test.ts
    ├── chat_agent.test.ts
    ├── synology_client.test.ts
    ├── database.test.ts
    └── tfidf.test.ts
```

### Data Flow

1. **Incoming Request** → Synology Chat sends a webhook to `/chat/bot`, `/chat/slash`, or `/chat/group`
2. **Authentication** → Each endpoint validates its respective token (`CHAT_TOKEN_BOT`, `CHAT_TOKEN_SLASH`, `CHAT_TOKEN_GROUP`)
3. **Processing & Matching** → `ChatAgent` invokes `ContextService` on _every turn_ of the conversation.
   - Computes TF-IDF similarity between prompt and eagerly loaded document titles.
   - Mandatorily fetches the sender's background (e.g. `Background on zara`).
   - Filters out already loaded titles using the session's active conversation cache.
   - Wraps newly loaded context pieces in structured XML tags (`<context_entry title="...">...</context_entry>`) and prepends them to the prompt.
   - Calls the Mistral API and manages 12-hour session state.
4. **Formatting** → `SynologyClient` strips markdown formatting (bold, headers) and chunks long responses (>1800 chars) for Synology's limits
5. **Response** → Answers are sent back to Synology Chat via its API

### Key Classes & Services

- **`ChatAgent`** (`src/chat_agent.ts`): Core LLM integration. Manages conversation lifecycle (create/new), dynamically tracks `loadedContextTitles` per active session, and formats/prepends new context turn-by-turn.
- **`ContextService`** (`src/services/context.service.ts`): Handles loading matching documents, executing TF-IDF matches, filtering out duplicates, and formatting them into XML.
- **`TfIdfService`** (`src/services/tfidf.service.ts`): Pure calculations including term frequency (TF), Inverse Document Frequency (IDF), and cosine similarity between user prompts and document titles.
- **`DbProxy`** (`src/database/db_proxy.ts`): Relational database proxy, pre-populated with standard prose Markdown backgrounds.

## Development Commands

| Command                                    | Description                                           |
| ------------------------------------------ | ----------------------------------------------------- |
| `npm start` or `npm run s`                 | Start development server with nodemon                 |
| `npm test`                                 | Run all Jest tests                                    |
| `npm run test -- --testPathPattern=<file>` | Run a single test file                                |
| `npm run test -- --testNamePattern=<name>` | Run tests matching a name pattern                     |
| `npm run lint`                             | Run ESLint on source files                            |
| `npm run format`                           | Format all files with Prettier                        |
| `npm run check`                            | Run both format and lint                              |
| `npm run manage-context <command>`         | Run context administration commands (list, create...) |

## Testing

- Tests use Jest with `ts-jest` preset
- `fetch` is mocked globally for `ChatAgent` tests
- Test files follow pattern `src/__tests__/<module>.test.ts`
- Code coverage includes: TF-IDF similarity, XML context injection, connection pool retry logic, conversation management, response parsing, markdown stripping, text chunking

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
