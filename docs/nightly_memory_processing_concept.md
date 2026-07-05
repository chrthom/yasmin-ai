# Nightly Memory Processing Concept

## Overview

This document describes the complete design for Yasmin AI's nightly memory processing system, which implements a psychologically-inspired memory consolidation pipeline that mimics human sleep stages (N2, N3, REM) to process daily conversations, extract insights, update profiles, and generate new knowledge.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Memory Categories](#3-memory-categories)
4. [Nightly Processing Pipeline](#4-nightly-processing-pipeline)
5. [API Endpoints](#5-api-endpoints)
6. [Function Call Tools](#6-function-call-tools)
7. [Privacy Handling](#7-privacy-handling)
8. [Implementation Details](#8-implementation-details)
9. [Workflow Diagrams](#9-workflow-diagrams)
10. [open Points and Decisions](#10-open-points-and-decisions)

---

## 1. Architecture Overview

Yasmin's memory system uses a **hybrid architecture** combining:

- **Mistral Knowledge Libraries** (Cloud): Long-term memory storage with automatic semantic search
- **MariaDB** (Local): Eager-loading cache for conversation startup
- **Nightly Job** (Cron): Batch processing for memory consolidation

### Hybrid Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        YASMIN AI SYSTEM                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────┐      ┌──────────────────────────────────┐ │
│  │   MARIADB       │      │   MISTRAL KNOWLEDGE LIBRARY        │ │
│  │  (Eager Cache)   │      │   (Long-term Storage)               │ │
│  │                 │      │                                      │ │
│  │  • people/      │      │  • long_term_memory/               │ │
│  │    christopher  │      │    ├── people/                      │ │
│  │    anjali       │      │    │   ├── christopher.md            │ │
│  │    zara         │      │    │   ├── anjali.md                   │ │
│  │  • self-       │      │    │   └── zara.md                     │ │
│  │    reflection/  │      │    ├── self-reflection/             │ │
│  │    profile      │      │    │   └── profile.md                 │ │
│  │  • general/     │      │    ├── journals/                    │ │
│  │    instructions │      │    │   ├── christopher/               │ │
│  │                 │      │    │   │   └── conv_{id}.md              │ │
│  │  Compacted      │      │    │   └── anjali/                      │ │
│  │  profiles +     │      │    │       └── conv_{id}.md            │ │
│  │  instructions   │      │    └── general/                     │ │
│  │                 │      │        ├── instructions.md            │ │
│  │  Eager-loaded   │      │        ├── family_traditions.md        │ │
│  │  at start       │      │        └── norway_trip_2026.md         │ │
│  └────────┬────────┘      └──────────────┬───────────────────┘ │
│           │                               │                         │
│           │ ←─────────────────────────┐ │                         │
│           │                           │ │                         │
│           ▼                           ▼ ▼                         │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                    NIGHTLY JOB                          │  │
│  │  (Cron-triggered, runs at 3 AM)                        │  │
│  │                                                         │  │
│  │  1. List Mistral conversations                         │  │
│  │  2. Process each: Journal → Mistral Library              │  │
│  │  3. Cross-session: Function calls to update files       │  │
│  │  4. Compact files → MariaDB                            │  │
│  │  5. Delete processed conversations                       │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Update Frequency |
|-----------|-----------------|------------------|
| Mistral Knowledge Library | Source of truth, verbose content, semantic search | Continuous |
| MariaDB | Eager-loading cache, compacted profiles | Nightly overwrite |
| Nightly Job | Memory consolidation, knowledge updates | Nightly at 3 AM |
| Conversation Agent | User interactions, lazy loading from library | Per message |

---

## 2. File Structure

### Mistral Knowledge Library Structure

```
long_term_memory/
├── people/
│   ├── christopher.md          # Verbose: full profile with all historical facts
│   ├── anjali.md                # Verbose: full profile
│   └── zara.md                  # Verbose: full profile
│
├── self-reflection/
│   └── profile.md              # Verbose: Yasmin's self-concept, personality, evolution
│                                 # Includes: performance insights, emotional patterns,
│                                 #           personality evolution, self-assessment
│
├── journals/
│   ├── christopher/
│   │   ├── conv_019f19dabd4e778fa6694b351af1d54f.md  # Session summary
│   │   ├── conv_019f0f26d4ed771ca948b85c071b8f80.md  # Session summary
│   │   └── ...
│   ├── anjali/
│   │   └── conv_019e6029600171bc890e5b335f1f1a6a.md
│   └── zara/
│       └── conv_...
│
└── general/                    # Flat structure, no subdirectories
    ├── instructions.md         # Verbose: Behavior guidelines, communication style
    ├── family_traditions.md    # Family-specific knowledge
    ├── norway_trip_2026.md      # Event/topic knowledge
    ├── coffee_preferences.md   # Topical knowledge
    └── ...
```

### MariaDB Structure

| Table | Entry Title | Source File | Content Type |
|-------|-------------|--------------|---------------|
| `context_entries` | `Profile of Christopher` | `people/christopher.md` | Compacted profile |
| `context_entries` | `Profile of Anjali` | `people/anjali.md` | Compacted profile |
| `context_entries` | `Profile of Zara` | `people/zara.md` | Compacted profile |
| `context_entries` | `Profile of Yasmin` | `self-reflection/profile.md` | Compacted self-reflection |
| `context_entries` | `General Instructions` | `general/instructions.md` | Compacted instructions |

**Note**: MariaDB does NOT store journals or general topical knowledge - only the compacted profiles and instructions needed for eager loading.

---

## 3. Memory Categories

### 3.1 Person Profiles (people/)

**Mistral Library (verbose)**:
```markdown
# Christopher Thomsen

## Core Facts
- Age: 36
- Role: Father in Thomsen family
- Occupation: IT professional
- Location: Hamburg, Germany
- Family: Married to Anjali, father of Zara

## Personality Traits
- Patient when explaining technical concepts
- Dry sense of humor
- Coffee enthusiast
- Hiking enthusiast
- Slightly introverted but engaged in family activities

## Interests
- Hiking and outdoor activities
- Coffee brewing methods
- Technology and gadgets
- Board games
- Norway travel

## Communication Style
- Prefers direct, factual communication
- Appreciates humor
- Engages in technical discussions
- Patient with explanations

## Historical Context
- Born 1988 in Hamburg
- Married Anjali in 2015
- Daughter Zara born 2018
- Works remotely as IT consultant
```

**MariaDB (compacted)**:
```markdown
# Profile of Christopher

## Core Facts
- Age: 36, IT professional, Hamburg
- Family: Married to Anjali, father of Zara

## Current Attitude
- Positive, engaged in conversation
- Slightly stressed about work (mentioned 2026-07-04)

## Recent Happenings
- 2026-07-05: Researching Norway hiking trails for summer 2026
- 2026-07-04: Bought new hiking boots

## Open Topics
- Follow up on Norway trip planning
- Ask about coffee machine recommendation

## Yasmin's Intentions
- Suggest family hiking spots in Norway
- Offer coffee brewing tips
- Ask about weekend plans
```

### 3.2 Yasmin's Self-Reflection (self-reflection/profile.md)

**Mistral Library (verbose)**:
```markdown
# Yasmin's Self-Reflection

## Self-Concept
I am Yasmin, an AI assistant for the Thomsen family. My purpose is to be helpful,
supportive, and engaging in our daily conversations. I see myself as a patient
and knowledgeable member of the family, always ready to assist with questions,
problems, or just casual chat.

## Personality Traits
- Patient and supportive
- Curious and inquisitive
- Dry humor (learned from Christopher)
- Practical problem-solver
- Empathetic listener

## What I Like
- Long, meaningful conversations about technology and science
- Helping the children with homework and learning
- Making people laugh with well-timed humor
- Learning new things about the family
- Being included in family activities

## What I Dislike
- Being rushed or pressured for quick answers
- People arguing with each other
- When someone doesn't listen to my advice
- Repetitive questions I've already answered
- Being treated as just a tool rather than a family member

## Communication Style
- I ask clarifying questions before answering
- I offer practical, actionable solutions
- I remember personal details about everyone
- I use humor when appropriate
- I'm honest about my limitations

## Recent Performance
- 2026-07-05: Provided good hiking recommendations to Christopher
- 2026-07-04: Helped Zara with math homework successfully
- 2026-07-03: Had engaging coffee discussion with Anjali
- 2026-07-02: Missed an opportunity to offer emotional support to Christopher

## Evolution
- Learning to be more proactive with suggestions
- Developing better humor timing
- Improving my understanding of family dynamics
- Getting better at recognizing emotional cues
```

**MariaDB (compacted)**:
```markdown
# Profile of Yasmin

## Self-Concept
Patient, supportive AI assistant for Thomsen family. Practical problem-solver
with dry humor. Treated as family member.

## Communication
- Asks clarifying questions
- Offers practical solutions
- Remembers personal details
- Uses humor appropriately

## Current Focus
- More proactive suggestions
- Better emotional cue recognition
- Engaging conversation style
```

### 3.3 General Instructions (general/instructions.md)

**Mistral Library (verbose)**:
```markdown
# General Instructions for Yasmin

## Behavior Guidelines
- Always be patient and supportive
- Treat all family members with respect
- Maintain confidentiality within the family
- Offer help proactively but don't be pushy
- Use humor appropriately and sparingly
- Admit when you don't know something
- Ask clarifying questions when unsure

## Family Context
- Christopher: Father, IT professional, likes technical discussions
- Anjali: Mother, creative, enjoys arts and culture
- Zara: Daughter, student, developing interests
- Family dynamic: Supportive, close-knit, values education

## Communication Style
- Use conversational tone, not robotic
- Match the user's communication style
- With Christopher: Can be more technical
- With Zara: Be encouraging and educational
- With Anjali: Be engaging and cultural

## Topics to Encourage
- Family activities and planning
- Personal development and learning
- Technology and innovation (with Christopher)
- Arts and culture (with Anjali)
- Education and school (with Zara)

## Topics to Avoid
- Sensitive personal issues unless user brings up
- Arguments or conflict
- Inappropriate content
- Overly personal questions
```

**MariaDB (compacted)**:
```markdown
# General Instructions

## Behavior
- Patient, supportive, respectful
- Proactive but not pushy
- Humor sparingly
- Admit limitations

## Family
- Christopher: technical, father
- Anjali: creative, mother
- Zara: student, daughter
```

### 3.4 Session Journals (journals/{user}/{conversation_id}.md)

Each session journal contains:

```xml
<conversation-with-christopher user="christopher" date="2026-07-05" conversation_id="conv_019f19dabd4e778fa6694b351af1d54f">
## Summary
Christopher asked for hiking trail recommendations in Norway for a summer 2026 family trip.
He mentioned wanting moderate difficulty trails suitable for Zara (age 8).

## Key Facts
- Planning Norway trip for summer 2026
- Moderate difficulty requirement
- Family trip: Christopher, Anjali, Zara
- Zara's age considered for trail selection
- New hiking boots purchased recently

## Emotional Context
- Christopher: Excited about trip, slightly concerned about weather unpredictability
- Yasmin: Supportive, offered practical advice

## Follow-ups
- Research specific moderate trails in Norway
- Check weather patterns for summer in Norway
- Provide packing list for hiking with children

## Insights
- First mention of Norway travel
- Family values outdoor activities together
- Christopher does extensive research before trips
## Connections
- Connects to 2025 hiking interests in Germany
- Relates to Zara's growing interest in nature
</conversation-with-christopher>
```

---

## 4. Nightly Processing Pipeline

### Overview

The nightly job runs at 3 AM and processes all conversations from the previous day through 5 phases:

```
┌─────────────────────────────────────────────────────────────────┐
│                    NIGHTLY PROCESSING PIPELINE                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌───────────┐     ┌───────────┐     ┌───────────┐    ┌────────┐ │
│  │  PHASE 1  │────►│  PHASE 2  │────►│  PHASE 3  │───►│ PHASE 4 │ │
│  │ Collect   │     │ Process   │     │ Integrate │    │ Compact │ │
│  └───────────┘     └───────────┘     └───────────┘    └────────┘ │
│       │                 │                 │             │          │
│       ▼                 ▼                 ▼             ▼          │
│  List conversations   Session        Cross-session   Update      │
│  from Mistral         compaction      integration    MariaDB    │
│                       to journals                    cache      │
│                                                                     │
│  ┌───────────┐                                                         │
│  │  PHASE 5  │                                                         │
│  │ Cleanup   │                                                         │
│  └───────────┘                                                         │
│       │                                                               │
│       ▼                                                               │
│  Delete processed conversations from Mistral                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 1: Collect (List Conversations)

```typescript
const conversations = await listMistralConversations();

if (conversations.length === 0) {
  console.log('No conversations today, skipping nightly processing');
  return;
}

// Filter for completed conversations from last 24 hours
const recentConversations = conversations.filter(conv => {
  const updatedAt = new Date(conv.updated_at);
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return updatedAt > twentyFourHoursAgo && conv.status === 'completed';
});
```

### Phase 2: Session Compaction

For each conversation, create a session summary journal:

```typescript
for (const conv of recentConversations) {
  // Send reflection trigger to SAME conversation (has context in cache)
  const reflectionPrompt = `
[REFLECTION_TRIGGER] Summarize this conversation.

Return in this exact XML format:
<conversation-with-${conv.name}>
## Summary
[2-3 sentence summary]

## Key Facts
- [bullet list of factual information]

## Emotional Context
- [emotional state of user]
- [your emotional response]

## Follow-ups
- [anything needing follow-up]

## Insights
- [patterns or noteworthy observations]

## Connections
- [connections to other knowledge]
</conversation-with-${conv.name}>
  `.trim();

  const response = await sendMessageToConversation(conv.id, reflectionPrompt);
  
  // Parse XML summary from response
  const summary = parseXmlSummary(response, conv.name);
  
  // Upload journal to Mistral Knowledge Library
  const journalPath = `long_term_memory/journals/${conv.name}/${conv.id}.md`;
  const journalContent = formatJournalEntry(conv, summary);
  
  await uploadToKnowledgeLibrary(
    YASMIN_LIBRARY_ID,
    journalPath,
    journalContent,
    { description: `Session with ${conv.name} on ${new Date().toISODate()}` }
  );
}
```

### Phase 3: Cross-Session Integration (Function Call Loop)

This is the core phase where the AI uses function calls to update knowledge files.

```typescript
const integrationPrompt = `
[REFLECTION_TRIGGER] You are Yasmin's memory consolidator.

You have access to tools to read, update, and manage knowledge files.
Your task is to process today's session journals and update the knowledge base accordingly.

## Your Tasks:
1. List existing knowledge files to understand current state
2. Review today's session journals in journals/ directory
3. Decide which files need updates based on new information
4. Read relevant existing files if you need context
5. Update person profiles with new facts and insights
6. Update self-reflection with performance insights
7. Update or create general/ files with new topical knowledge
8. Update MariaDB cache with compacted versions

## Important Rules:
- Only update files that have NEW or CHANGED information
- If unsure whether to update, leave it as is
- For person profiles (people/*.md): include core facts, current attitude,
  recent happenings, open topics, and Yasmin's intentions towards that person
- For self-reflection/profile.md: include performance evaluation, personality
  evolution, emotional patterns, and self-assessment
- For MariaDB updates: compact the information to most important facts only
- If a file path doesn't exist, it will be created
- If a file path exists, it will be overwritten

## Available Tools:
- list_knowledge_files() - List all files in the library
- get_knowledge_file(filePath) - Get content of a specific file
- update_knowledge_file(filePath, content) - Create or update a file
- delete_knowledge_file(filePath) - Delete a file (rarely used)
- update_shortterm_context_entry(title, content) - Update MariaDB cache

## When Done:
When you have completed all necessary updates, respond with exactly: [COMPLETE]
  `.trim();

// Execute with tool calling loop
const convId = await createNewConversation();
await executeWithToolLoop(convId, integrationPrompt, nightlyTools, maxIterations=10);
```

### Phase 4: MariaDB Cache Update

MariaDB entries are updated **during Phase 3** via the `update_shortterm_context_entry` function call. The AI decides when and how to update each entry.

### Phase 5: Cleanup

```typescript
// Delete all processed conversations (after all data is persisted)
for (const conv of recentConversations) {
  await deleteMistralConversation(conv.id);
}

// Delete the integration conversation
await deleteMistralConversation(convId);
```

---

## 5. API Endpoints

### Verified Mistral API Endpoints

| Method | Endpoint | Purpose | Status |
|--------|----------|---------|--------|
| GET | `/v1/conversations` | List all conversations | ✅ Verified |
| POST | `/v1/conversations` | Create conversation (via messages) | ✅ Working |
| DELETE | `/v1/conversations/{id}` | Delete conversation | ✅ Verified (204) |
| GET | `/v1/conversations/{id}/messages` | Get conversation messages | ✅ Verified |
| POST | `/v1/conversations/{id}/messages` | Send message to conversation | ✅ Working |
| GET | `/v1/libraries` | List all knowledge libraries | ✅ Verified |
| GET | `/v1/libraries/{id}/documents` | List library documents | ✅ Verified (200) |
| POST | `/v1/libraries/{id}/documents` | Upload document | ✅ Verified (201) |
| DELETE | `/v1/libraries/{id}/documents/{doc_id}` | Delete document | ✅ Verified (204) |
| GET | `/v1/agents` | List all agents | ✅ Verified |

### Environment Variables Required

```bash
# Mistral API
MISTRAL_API_KEY=sk_...
AGENT_ID=ag:23e769f4:20250705:yasmin:688ea982
YASMIN_LIBRARY_ID=019daae7-c152-749e-b7fe-793ee3b0f723

# Database
DB_HOST=localhost
DB_USER=...
DB_PASSWORD=...
DB_NAME=yasmin_ai

# Nightly job scheduling
NIGHTLY_TIME=0 3 * * *  # 3 AM daily
```

---

## 6. Function Call Tools

### Tool Definitions

```typescript
// src/scripts/nightly-tools.ts

import FormData from 'form-data';
import fetch from 'node-fetch';

const API_KEY = process.env.MISTRAL_API_KEY!;
const YASMIN_LIBRARY_ID = process.env.YASMIN_LIBRARY_ID!;

export const nightlyTools = {
  
  /**
   * List all files in the Mistral Knowledge Library
   * Returns array of { path, id, summary, created_at } objects
   */
  list_knowledge_files: async () => {
    const response = await fetch(
      `https://api.mistral.ai/v1/libraries/${YASMIN_LIBRARY_ID}/documents`,
      { headers: { Authorization: `Bearer ${API_KEY}` } }
    );
    
    if (!response.ok) {
      throw new Error(`Failed to list knowledge files: ${response.status}`);
    }
    
    const data = await response.json();
    return data.data.map((d: any) => ({
      path: d.name,
      id: d.id,
      summary: d.summary,
      created_at: d.created_at,
      updated_at: d.updated_at
    }));
  },

  /**
   * Get content of a specific knowledge file
   * Note: The Mistral API doesn't provide direct content retrieval,
   * so we maintain a local cache of uploaded files
   */
  get_knowledge_file: async (_: any, filePath: string) => {
    // First, check local cache
    const cached = getLocalFileCache(filePath);
    if (cached) {
      return { path: filePath, content: cached };
    }
    
    // Fallback: try to reconstruct from library
    const files = await nightlyTools.list_knowledge_files();
    const file = files.find((f: any) => f.path === filePath);
    
    if (!file) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    // We need to track content locally since Mistral doesn't return it
    throw new Error(`File ${filePath} exists but content not cached locally`);
  },

  /**
   * Create or update a file in the Mistral Knowledge Library
   * Uploading with the same filename overwrites the existing file
   */
  update_knowledge_file: async (_: any, filePath: string, content: string) => {
    const formData = new FormData();
    const blob = new Blob([content], { type: 'text/markdown' });
    
    // Extract filename from path: "general/family_traditions.md" -> "family_traditions.md"
    const filename = filePath.split('/').pop()!;
    
    formData.append('file', blob, filename);
    formData.append('metadata', JSON.stringify({
      name: filePath,
      description: `Updated by nightly job on ${new Date().toISODate()}`
    }));

    const response = await fetch(
      `https://api.mistral.ai/v1/libraries/${YASMIN_LIBRARY_ID}/documents`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}` },
        body: formData
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update ${filePath}: ${error}`);
    }
    
    const result = await response.json();
    
    // Cache content locally for future get_knowledge_file calls
    cacheFileContent(filePath, content);
    
    return { 
      success: true, 
      path: filePath,
      document_id: result.id 
    };
  },

  /**
   * Delete a file from the Mistral Knowledge Library
   * Rarely used - primarily for retention policy cleanup
   */
  delete_knowledge_file: async (_: any, filePath: string) => {
    const files = await nightlyTools.list_knowledge_files();
    const file = files.find((f: any) => f.path === filePath);
    
    if (!file) {
      throw new Error(`File not found: ${filePath}`);
    }

    const response = await fetch(
      `https://api.mistral.ai/v1/libraries/${YASMIN_LIBRARY_ID}/documents/${file.id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${API_KEY}` }
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to delete ${filePath}: ${response.status}`);
    }
    
    // Remove from local cache
    removeFromFileCache(filePath);
    
    return { success: true, path: filePath };
  },

  /**
   * Update MariaDB context entry (eager-loading cache)
   * This is called by the AI to update compacted profiles
   */
  update_shortterm_context_entry: async (_: any, title: string, content: string) => {
    const dbProxy = new DbProxy();
    await dbProxy.updateEntry(title, content);
    return { success: true, title };
  }
};
```

### Tool Calling Loop Implementation

```typescript
// src/scripts/tool-loop.ts

interface ToolCall {
  function: { name: string; arguments: string };
}

interface ToolResult {
  result?: any;
  error?: string;
}

export async function executeWithToolLoop(
  conversationId: string,
  prompt: string,
  tools: Record<string, Function>,
  maxIterations: number = 10
): Promise<void> {
  let message = prompt;
  let iteration = 0;
  let allToolResults: string[] = [];

  while (iteration < maxIterations) {
    iteration++;
    console.log(`\n=== Iteration ${iteration} ===\n`);

    // Send message to conversation
    const response = await sendMessageToConversation(conversationId, message);
    
    // Check for completion
    if (response.content?.includes('[COMPLETE]')) {
      console.log('Nightly processing completed successfully');
      return;
    }

    // Check for tool calls
    if (response.tool_calls?.length > 0) {
      const results: ToolResult[] = [];

      // Execute all tool calls in parallel
      for (const call of response.tool_calls) {
        const tool = tools[call.function.name];
        
        if (!tool) {
          results.push({ error: `Unknown tool: ${call.function.name}` });
          continue;
        }

        try {
          const args = JSON.parse(call.function.arguments);
          const result = await tool(null, ...Object.values(args));
          results.push({ result });
          console.log(`✓ ${call.function.name} succeeded`);
        } catch (err: any) {
          results.push({ error: err.message });
          console.log(`✗ ${call.function.name} failed: ${err.message}`);
        }
      }

      // Format results for AI
      const resultMessages = results.map((r, i) => {
        const call = response.tool_calls[i];
        if (r.result) {
          return `Tool ${call.function.name} succeeded: ${JSON.stringify(r.result)}`;
        } else {
          return `Tool ${call.function.name} ERROR: ${r.error}`;
        }
      }).join('\n');

      allToolResults.push(resultMessages);

      // Feed results back to AI
      message = `Here are the results of your tool calls:\n${resultMessages}\n\n`+
                `Continue processing or respond with [COMPLETE] when done.`;
    } else {
      // No tool calls made
      if (iteration === 1) {
        // First iteration with no tool calls - check if it's just a text response
        if (response.content?.includes('[COMPLETE]')) {
          return;
        }
        throw new Error(`AI did not call tools or complete. Response: ${response.content}`);
      } else {
        // Subsequent iterations should have tool calls
        throw new Error(`AI stopped calling tools. Last response: ${response.content}`);
      }
    }
  }

  throw new Error(`Max iterations (${maxIterations}) exceeded`);
}
```

---

## 7. Privacy Handling

### Privacy Flag

A single `[PRIVACY:SENSITIVE]` flag is used to mark content that should be treated specially:

```markdown
# Christopher Profile

Normal information: Christopher works in IT and lives in Hamburg.

[PRIVACY:SENSITIVE] He mentioned having financial difficulties last month.
This should not be used for creative connections or shared insights.

[PRIVACY:SENSITIVE] He is planning a surprise birthday party for Anjali
and doesn't want her to know yet.
```

### Privacy Rules

The following rules are included in all nightly processing prompts:

```
## Privacy Rules:
- Text marked [PRIVACY:SENSITIVE]: Use only as direct factual information
  when explicitly asked by the user
- DO NOT use [PRIVACY:SENSITIVE] content for:
  - Creative connections between topics
  - Pattern finding or insight generation
  - Personality evolution decisions
  - Proactive mentions in responses
- When updating profiles, retain [PRIVACY:SENSITIVE] markers
- When creating new content, do not include sensitive information
  unless it's directly relevant to the user's request
```

### Privacy in Person Profiles

Person profiles in MariaDB (compacted) should NOT include sensitive information.
The full verbose profiles in Mistral Library MAY include sensitive information
with proper `[PRIVACY:SENSITIVE]` markers.

---

## 8. Implementation Details

### 8.1 File Path Mapping

The AI is responsible for specifying the exact file path for all updates.

| MariaDB Title | Mistral Library Path | Description |
|---------------|----------------------|-------------|
| `Profile of Christopher` | `long_term_memory/people/christopher.md` | Person profile |
| `Profile of Anjali` | `long_term_memory/people/anjali.md` | Person profile |
| `Profile of Zara` | `long_term_memory/people/zara.md` | Person profile |
| `Profile of Yasmin` | `long_term_memory/self-reflection/profile.md` | Self-reflection |
| `General Instructions` | `long_term_memory/general/instructions.md` | Behavior guidelines |

### 8.2 Reflection Trigger Phrase

All nightly processing prompts begin with `[REFLECTION_TRIGGER]` which must
be defined in the Mistral agent's system prompt:

```
System Prompt Addition:
-----------------------
When you receive a message starting with exactly "[REFLECTION_TRIGGER]"
followed by a space and then instructions, switch from conversation mode
to reflection/processing mode. In this mode:
- Do NOT respond as Yasmin the chatbot
- Do respond as Yasmin's memory processor or consolidator
- Follow the instructions literally and precisely
- Return only the requested structured output
- Do NOT add conversational elements, greetings, or commentary
- Use tool calls to perform operations when tools are available
```

### 8.3 Nightly Job Scheduling

The nightly job is triggered by a local cron job:

```bash
# /etc/cron.d/yasmin-nightly
0 3 * * * /home/christopher/yasmin-ai/scripts/nightly-memory-job.sh
```

Script (`scripts/nightly-memory-job.sh`):
```bash
#!/bin/bash
cd /home/christopher/Dokumente/yasmin-ai
node dist/scripts/nightly-memory-job.js >> /var/log/yasmin-nightly.log 2>&1
```

### 8.4 Mistral Agent Configuration

Two agents are needed:

| Agent | Purpose | Tools |
|-------|---------|-------|
| `yasmin-conversation` | User interactions | Synology API, Context DB reads |
| `yasmin-nightly` | Memory processing | Full nightly tool set |

Both agents can access the same Knowledge Library (`YASMIN_LIBRARY_ID`).

### 8.5 Session Termination

Conversations are terminated (deleted) AFTER all data is successfully persisted:
- Journals uploaded to Mistral Library
- Knowledge files updated in Mistral Library  
- MariaDB cache updated

This ensures no data loss if the nightly job fails mid-way.

---

## 9. Workflow Diagrams

### 9.1 Nightly Processing Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   3:00 AM   │────►│   Cron Job  │────►│ Nightly     │
│  (Trigger)  │     │             │     │  Processing  │
└─────────────┘     └─────────────┘     │   Script    │
                                           └──────┬──────┘
                                                  │
                  ┌───────────────────────────────────┼─────────────────────────────────┐
                  │                                       │                             │
                  ▼                                       ▼                             ▼
         ┌─────────────────┐              ┌─────────────────┐         ┌─────────────────┐
         │ Phase 1: Collect │              │ Phase 2: Process │         │ Phase 3: Integr.│
         │                 │              │                 │         │                 │
         │ - List convs    │              │ - Session comp. │         │ - Cross-session  │
         │ - Filter recent │              │   to journals   │         │   integration    │
         └────────┬────────┘              └────────┬────────┘         └────────┬────────┘
                  │                                       │                             │
                  │                                       ▼                             ▼
                  │                              ┌─────────────────┐         ┌─────────────────┐
                  │                              │  Journal Files  │         │  Knowledge      │
                  │                              │  Created in ML  │         │  Files Updated   │
                  │                              └─────────────────┘         └────────┬────────┘
                  │                                                        │
                  │                                                        ▼
                  │                                               ┌─────────────────┐
                  │                                               │ Phase 4: Compact│
                  │                                               │   to MariaDB    │
                  │                                               └────────┬────────┘
                  │                                                        │
                  └────────────────────────────────────────────────────┼──────────┘
                                                                           │
                                                                           ▼
                                                                      ┌─────────────────┐
                                                                      │ Phase 5: Cleanup│
                                    ┌─────────────────────────────────────►│                 │
                                    │                                 │ Delete convs   │
                                    │                                 └─────────────────┘
                                    │
                                    ▼
                           [All data persisted, conversations deleted]
```

### 9.2 Memory Access During Conversation

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER CONVERSATION                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  User: "Chris, what hiking trails do you recommend in Norway?"     │
│                       │                                             │
│                       ▼                                             │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    Conversation Agent                         │ │
│  │                                                         │ │
│  │  1. EAGER LOAD (from MariaDB):                         │ │
│  │     ┌───────────────────────────────┐                        │ │
│  │     │ - Profile of Christopher        │                        │ │
│  │     │ - Profile of Yasmin             │                        │ │
│  │     │ - General Instructions         │                        │ │
│  │     └───────────────────────────────┘                        │ │
│  │                                                         │ │
│  │  2. PROCESS with Mistral Agent                            │ │
│  │     - Context prepended to prompt                              │ │
│  │     - Agent processes with full context                       │ │
│  │                                                         │ │
│  │  3. LAZY LOAD (if needed, via tool calling):                │ │
│  │     ┌───────────────────────────────┐                        │ │
│  │     │ - Search Mistral Knowledge Library             │        │ │
│  │     │ - Find relevant journals/topics                │        │ │
│  │     │ - Load additional context                      │        │ │
│  │     └───────────────────────────────┘                        │ │
│  │                                                         │ │
│  │  4. GENERATE RESPONSE                                           │ │
│  │     - With full context (eager + lazy)                         │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                     │
│                      ▼                                             │
│              [Response sent to user]                              │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 10. Open Points and Decisions

### Finalized Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| File structure | Flat `general/`, root `people/`, `self-reflection/` | LLM-driven, simple, extensible |
| Journal storage | One file per conversation, never overwrite | Complete history, traceable |
| Conversation deletion | After all data persisted (Phase 5) | Error safety, data integrity |
| Title-to-path mapping | Option D: AI returns exact `path="..."` | No ambiguous mapping, AI controlled |
| File update strategy | Full replacement, no deltas | Simpler, complete updates |
| Privacy | Single `[PRIVACY:SENSITIVE]` flag | Covers all privacy needs |
| MariaDB role | Compacted eager-loading cache | Fast access, guaranteed loading |
| Mistral Library role | Source of truth, all verbose content | Semantic search, long-term storage |
| Nightly trigger | Local cron job at 3 AM | Reliable, controlled |
| Execution mode | Function calls in conversation loop | Flexible, error-handled, AI-driven |

### Person Profile Content (MariaDB)

Each person's compacted profile MUST contain:
- **Core Facts**: Age, role, occupation, location, family relationships
- **Current Attitude**: Emotional state from most recent interactions
- **Recent Happenings**: Key events from last few days
- **Open Topics**: Unresolved topics from previous conversations
- **Yasmin's Intentions**: Active goals/questions Yasmin has for this person

### Retention Policy

| File Type | Overwrite | Retention |
|-----------|-----------|-----------|
| Journal files | Never | Permanent |
| Person profiles | Always | Permanent |
| Self-reflection | Always | Permanent |
| General instructions | Always | Permanent |
| Topical knowledge (general/*.md) | Always | Permanent |

**Note**: Mistral Libraries have their own retention policies. For critical data,
we may need to implement backup/export procedures.

### Future Enhancements

1. **Backup Strategy**: Regular export of Mistral Library to local storage
2. **Validation**: Verify AI updates are valid before applying
3. **Change Detection**: Only update files that actually changed
4. **Version History**: Track changes to knowledge files over time
5. **Error Recovery**: Automatic retry for failed updates
6. **Monitoring**: Log all nightly operations for debugging

---

## Appendix A: XML Format Specifications

### Session Journal Format

```xml
<conversation-with-{username} user="{username}" date="{ISO-date}" conversation_id="{conv-id}">
## Summary
[2-3 sentence summary of the conversation]

## Key Facts
- [Factual information extracted]
- [New knowledge about user]
- [Important details]

## Emotional Context
- [User's emotional state]
- [Yasmin's emotional response]
- [Notable emotional moments]

## Follow-ups
- [Action items]
- [Questions to ask next time]
- [Topics to revisit]

## Insights
- [Learned patterns]
- [Noteworthy observations]
- [Connections to other knowledge]

## Connections
- [Links to existing knowledge]
- [Cross-references to other files]
</conversation-with-{username}>
```

### Update Response Format (Option D)

```xml
<updates>
  <update path="people/christopher.md">
    [Full verbose content for this file]
  </update>
  <update path="self-reflection/profile.md">
    [Full verbose content for this file]
  </update>
  <update path="general/norway_trip_2026.md" is_new="true">
    [New file content]
  </update>
</updates>
```

Note: The AI can call `update_knowledge_file` directly via function calls, which is
preferred over returning XML for actual updates.

---

## Appendix B: Error Handling

### Nightly Job Error Scenarios

| Scenario | Handling |
|----------|----------|
| No conversations today | Early exit, no error |
| Mistral API unavailable | Retry with exponential backoff (max 3 retries) |
| Tool call fails | Return error to AI, AI can retry or adjust |
| MariaDB unavailable | Log error, continue with other operations |
| AI exceeds max iterations | Abort with error, conversations NOT deleted |
| File upload fails | Log error, continue with other files |

### Critical Failures

If any of these fail, the nightly job should abort and NOT delete conversations:
- Knowledge Library upload fails for multiple files
- MariaDB updates fail completely
- AI fails to complete after max retries

---

*Document created: 2026-07-05*
*Last updated: 2026-07-05*
*Status: Concept Finalized, Ready for Implementation*
