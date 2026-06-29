# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Yasmin AI** - An AI assistant API for thomsen.in that integrates with Synology Chat and the Mistral AI API.

This is a TypeScript/Node.js Express application that provides a chatbot interface between Synology Chat and Mistral's LLM API. It handles three types of chat interactions: bot chats, slash commands (`/yasmin`), and group chats.

## Code Architecture

### Source Structure

```
src/
├── app.ts              # Express server entry point with route handlers
├── chat_agent.ts       # Mistral AI API client - manages conversations and prompts
├── synology_client.ts  # Synology Chat API client - formats and sends responses
├── knowledge.ts        # Domain knowledge - family relations and ages for prompt context
└── __tests__/
    ├── app.test.ts
    ├── chat_agent.test.ts
    ├── synology_client.test.ts
    └── knowledge.test.ts
```

### Data Flow

1. **Incoming Request** → Synology Chat sends a webhook to `/chat/bot`, `/chat/slash`, or `/chat/group`
2. **Authentication** → Each endpoint validates its respective token (`CHAT_TOKEN_BOT`, `CHAT_TOKEN_SLASH`, `CHAT_TOKEN_GROUP`)
3. **Processing** → `ChatAgent` builds context-aware prompts using `Knowledge` (family relations, ages), calls Mistral API, manages conversation state (12-hour validity)
4. **Formatting** → `SynologyClient` strips markdown formatting (bold, headers) and chunks long responses (>1800 chars) for Synology's limits
5. **Response** → Answers are sent back to Synology Chat via its API

### Key Classes

- **`ChatAgent`** (`src/chat_agent.ts`): Core LLM integration. Handles conversation lifecycle (create/new), prompt construction with personalization, and response parsing (multipart text extraction). Uses conversation ID cache with 12-hour TTL.
- **`SynologyClient`** (`src/synology_client.ts`): Outbound message delivery. Formats responses for Synology Chat by removing markdown, chunks messages at newlines or 1800 characters, and sends via recursive fetch calls.
- **`Knowledge`** (`src/knowledge.ts`): Static knowledge base mapping usernames to family relations and ages. Used for prompt personalization.

## Development Commands

| Command                                    | Description                           |
| ------------------------------------------ | ------------------------------------- |
| `npm start` or `npm run s`                 | Start development server with nodemon |
| `npm test`                                 | Run all Jest tests                    |
| `npm run test -- --testPathPattern=<file>` | Run a single test file                |
| `npm run test -- --testNamePattern=<name>` | Run tests matching a name pattern     |
| `npm run lint`                             | Run ESLint on source files            |
| `npm run format`                           | Format all files with Prettier        |
| `npm run check`                            | Run both format and lint              |

## Testing

- Tests use Jest with `ts-jest` preset
- `fetch` is mocked globally for `ChatAgent` tests
- Test files follow pattern `src/__tests__/<module>.test.ts`
- Code coverage includes: prompt building, conversation management, response parsing, markdown stripping, text chunking

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
