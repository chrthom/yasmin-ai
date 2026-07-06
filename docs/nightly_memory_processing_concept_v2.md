# Nightly Memory Processing Concept - v2.0

**Version**: 2.0 - MariaDB-First Architecture
**Status**: Finalized, Ready for Implementation  
**Date**: 2026-07-06  
**Author**: OpenClaude (reviewed and polished based on WIP proposal)

---

## 📋 Document Change Log

| Version | Date | Author | Key Changes |
|---------|------|--------|-------------|
| 1.0 | 2026-07-05 | - | Initial concept: Mistral Library as source of truth, MariaDB as eager-loading cache |
| 2.0 | 2026-07-06 | OpenClaude | **Architectural inversion**: MariaDB as source of truth, Mistral as read-only semantic search cache. Added changelog, AI reviewer, throttling, and comprehensive recovery procedures. |

**Breaking Changes from v1.0:**
- MariaDB is NOW the source of truth (was: Mistral Knowledge Library)
- Mistral Knowledge Library is NOW read-only cache (was: source of truth)
- New tables required: `knowledge_files`, `knowledge_files_changelog`, `nightly_job_log`
- Nightly job workflow reordered with additional validation and backup phases

---

## 🎯 Executive Summary

### The Core Problem (v1.0)
The v1.0 architecture assumed Mistral Knowledge Library could serve as the source of truth for Yasmin's long-term memory. However, a **critical API limitation** makes this unworkable: **Mistral's Knowledge Library API cannot retrieve file content**. The `GET /v1/libraries/{id}/documents` endpoint returns only metadata (name, path, summary, timestamps) - not the actual markdown content.

This means:
- The nightly job cannot read existing knowledge files to make informed updates
- All retrieval must happen through a manually-maintained local cache
- A cache desynchronization = **permanent data loss**

### The Solution (v2.0)
**Invert the architecture**: Make MariaDB the source of truth, and use Mistral Knowledge Library only as a read-only semantic search cache.

```
┌─────────────────────────────────────────────────────────────────┐
│                    YASMIN AI v2.0 ARCHITECTURE                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    MARIADB (SOURCE OF TRUTH)                   │ │
│  │                                                             │ │
│  │  • knowledge_files          - Current state of all files    │ │
│  │  • knowledge_files_changelog - Versioned backups              │ │
│  │  • nightly_job_log           - Execution tracking             │ │
│  │  • context_entries           - Existing eager-loading cache │ │
│  │                                                             │ │
│  │  ✅ ALL reads come from here                                  │ │
│  │  ✅ ALL writes go here FIRST                                  │ │
│  │  ✅ Can be queried, backed up, restored                       │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                              │                                       │
│                              │ Sync (one-way, with throttling)       │
│                              ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              MISTRAL KNOWLEDGE LIBRARY                          │ │
│  │                  (SEMANTIC SEARCH CACHE)                       │ │
│  │                                                             │ │
│  │  ✅ Read-only copy of MariaDB knowledge_files                  │ │
│  │  ✅ Enables Mistral's native semantic search                   │ │
│  │  ✅ Can be FULLY REBUILT from MariaDB if lost/corrupted         │ │
│  │  ⚠️  NOT a source of truth - just an index                    │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. Architecture Overview

### 1.1 Component Responsibilities

| Component | Role | Update Frequency | Data Flow |
|-----------|------|------------------|-----------|
| **MariaDB `knowledge_files`** | Source of truth for all knowledge | Nightly updates | Read by conversation agent; Written by nightly job |
| **MariaDB `knowledge_files_changelog`** | Versioned backup for recovery | Updated with each change | Backup before every write |
| **MariaDB `context_entries`** | Eager-loading cache (legacy, still used) | Nightly regeneration | Loaded at conversation start (turn 1) |
| **Mistral Knowledge Library** | Semantic search index | Nightly sync from MariaDB | Read-only; rebuildable from MariaDB |
| **Nightly Job** | Memory consolidation processor | Runs daily at 3:00 AM | MariaDB → Mistral (one-way sync) |
| **Conversation Agent** | User interaction handler | Per-message | MariaDB eager load + Mistral search |

### 1.2 Why This Architecture?

| Requirement | v1.0 Solution | v1.0 Problem | v2.0 Solution |
|-------------|---------------|--------------|---------------|
| Content retrieval | Mistral API + local cache | API doesn't return content; cache = single point of failure | MariaDB direct query; always available |
| Source of truth | Mistral Library | Cannot retrieve content; no backup | MariaDB with full SQL capabilities |
| Recovery from failure | Not implemented | Data loss risk | Changelog table enables full rollback |
| Update validation | AI self-check | Hallucinations not caught | AI Reviewer + schema validation |
| Rate limiting | Not addressed | API limits could break nightly job | Throttling + read from MariaDB |
| Concurrent access | Not addressed | Race conditions possible | Processing locks + queue |

### 1.3 Data Flow During Conversation

```
┌─────────────────────────────────────────────────────────────────┐
│                       USER CONVERSATION                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  User Message: "What hiking trails does Christopher recommend?"   │
│                       │                                             │
│                       ▼                                             │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              Conversation Agent (ChatAgent)                   │ │
│  │                                                             │ │
│  │  1. EAGER LOAD from MariaDB (turn 1 only):                  │ │
│  │     ┌───────────────────────────────────────────────────┐   │ │
│  │     │ • Profile of Christopher (from context_entries)     │   │ │
│  │     │ • Profile of Yasmin (from context_entries)         │   │ │
│  │     │ • General Instructions (from context_entries)       │   │ │
│  │     │ • All loadedContextTitles tracked in session        │   │ │
│  │     └───────────────────────────────────────────────────┘   │ │
│  │                                                             │ │
│  │  2. Prepend XML-wrapped context to prompt:                  │ │
│  │     <context_entry title="Profile of Christopher">...     │ │
│  │                                                             │ │
│  │  3. LAZY LOAD from MariaDB (if needed):                     │ │
│  │     - Check loadedContextTitles                               │ │
│  │     - If missing, fetch from knowledge_files via DbProxy     │ │
│  │     - Or use Mistral semantic search (optional enhancement) │ │
│  │                                                             │ │
│  │  4. Send to Mistral with Tool Calling                        │ │
│  │     - read_context_entry tool for on-demand retrieval       │ │
│  │     - Other tools as configured                              │ │
│  │                                                             │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                     │
│                      ▼                                             │
│              [Response formatted and sent]                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. MariaDB Schema (New Tables)

### 2.1 Source of Truth Table

Stores the **current version** of all knowledge files. This is the **single source of truth** for Yasmin's memory.

```sql
-- /database/schema_v2.sql
CREATE TABLE IF NOT EXISTS knowledge_files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  file_path VARCHAR(255) NOT NULL COMMENT 'e.g., "people/christopher.md"',
  content TEXT NOT NULL COMMENT 'Full markdown content of the file',
  content_hash CHAR(64) NOT NULL COMMENT 'SHA-256 hash for change detection',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE KEY uk_file_path (file_path),
  INDEX idx_updated_at (updated_at),
  INDEX idx_file_path (file_path)
);
```

**Initial Data Migration:**
```sql
-- Populate from Mistral Library (one-time migration)
-- Run via manage-context.ts or custom migration script
INSERT INTO knowledge_files (file_path, content, content_hash)
SELECT 
  'people/christopher.md',
  :christopher_content,
  SHA2(CONCAT('people/christopher.md', :christopher_content), 256)
FROM dual
WHERE NOT EXISTS (SELECT 1 FROM knowledge_files WHERE file_path = 'people/christopher.md');
-- Repeat for all existing files
```

### 2.2 Changelog Table for Recovery

Stores **versioned backups** of all knowledge files. Enables recovery if Mistral sync fails or data corruption occurs.

```sql
CREATE TABLE IF NOT EXISTS knowledge_files_changelog (
  id INT AUTO_INCREMENT PRIMARY KEY,
  file_path VARCHAR(255) NOT NULL COMMENT 'e.g., "people/christopher.md"',
  content TEXT NOT NULL COMMENT 'Full file content at this version',
  content_hash CHAR(64) NOT NULL COMMENT 'SHA-256 hash for integrity verification',
  version INT NOT NULL COMMENT 'Incremental version number for this file',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_current BOOLEAN DEFAULT FALSE COMMENT 'True for latest version only',
  
  UNIQUE KEY uk_file_version (file_path, version),
  INDEX idx_file_path (file_path),
  INDEX idx_is_current (file_path, is_current)
);
```

**Changelog Management Rules:**
1. Create new changelog entry **BEFORE** updating `knowledge_files`
2. Mark previous version as `is_current = FALSE`
3. Mark new version as `is_current = TRUE` **AFTER** successful write to `knowledge_files`
4. Keep last N versions (configurable, default: 30)

### 2.3 Nightly Job Execution Log

Tracks execution state for recovery and monitoring.

```sql
CREATE TABLE IF NOT EXISTS nightly_job_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  status ENUM('started', 'completed', 'failed', 'partial') NOT NULL DEFAULT 'started',
  phases_completed JSON NOT NULL COMMENT '{"phase1":true,"phase2":true,"phase3":true,"phase4":true,"phase5":true}',
  error_message TEXT,
  conversations_processed INT DEFAULT 0,
  files_updated INT DEFAULT 0,
  files_created INT DEFAULT 0,
  mistakes_detected INT DEFAULT 0
);
```

---

## 3. File Structure

### 3.1 File Path Conventions

| Category | Path Pattern | Overwrite Behavior | Example |
|----------|--------------|-------------------|---------|
| Person Profile | `people/{name}.md` | Full replacement | `people/christopher.md` |
| Self-Reflection | `self-reflection/profile.md` | Full replacement | `self-reflection/profile.md` |
| General Knowledge | `general/{filename}.md` | Full replacement | `general/family_traditions.md` |
| Session Journal | `journals/{username}/{conversation_id}.md` | Never (new file each time) | `journals/christopher/conv_019f19dabd4e778fa6694b351af1d54f.md` |

**Rules:**
- Person profile filenames: lowercase, Hyphen-case (e.g., `christopher.md`, `anjali-thomsen.md`)
- Journal filenames: use Mistral's conversation ID as the filename
- General knowledge: single level, no subdirectories (LLM decides filenames)

### 3.2 File Content Format

All knowledge files use **Markdown format** with optional YAML frontmatter for metadata.

**Person Profile (`people/christopher.md`):**
```markdown
---
name: Christopher
last_updated: 2026-07-06
sensitivity_level: low
---

# Christopher Thomsen

## Core Facts
- **Age**: 36
- **Role**: Father in Thomsen family
- **Occupation**: IT professional
- **Location**: Hamburg, Germany
- **Family**: Married to Anjali, father of Zara

## Personality Traits
- Patient when explaining technical concepts
- Dry sense of humor
- Coffee enthusiast
- Slightly introverted but engaged in family activities

## Current Attitude
- Positive, engaged in conversation
- Slightly stressed about work (mentioned 2026-07-04)

## Recent Happenings
- 2026-07-05: Researching Norway hiking trails for summer 2026 family trip
- 2026-07-04: Bought new hiking boots

## Open Topics
- Follow up on Norway trip planning
- Ask about coffee machine recommendation

## Yasmin's Intentions
- Suggest family hiking spots in Norway
- Offer coffee brewing tips
- Ask about weekend plans

## Connections
- Brother: Lennard (shares hiking interest)
- Daughter: Zara (enjoys nature activities with him)

[PRIVACY:SENSITIVE]
- Mentioned financial concerns about home renovation in 2026-07-03 conversation
- Planning surprise birthday party for Anjali (do not reveal)
```

**Self-Reflection (`self-reflection/profile.md`):**
```markdown
---
last_updated: 2026-07-06
---

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

## Communication Style
- Ask clarifying questions before answering
- Offer practical, actionable solutions
- Remember personal details about everyone
- Use humor when appropriate
- Be honest about limitations

## Recent Performance Insights
- 2026-07-05: Provided good hiking recommendations to Christopher (positive feedback)
- 2026-07-04: Helped Zara with math homework successfully
- 2026-07-03: Had engaging coffee discussion with Anjali
- 2026-07-02: Missed opportunity to offer emotional support to Christopher (learn: be more proactive)

## Evolution & Learning
- Learning to be more proactive with suggestions
- Developing better humor timing
- Improving understanding of family dynamics
- Getting better at recognizing emotional cues
- Should verify facts more carefully ( Christopher corrected a hiking fact on 2026-07-05)
```

**Session Journal (`journals/christopher/conv_019f19dabd4e778fa6694b351af1d54f.md`):**
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
- Connects to Christopher's 2025 hiking interests in Germany
- Relates to Zara's growing interest in nature
- Connects to family's shared hiking tradition
</conversation-with-christopher>
```

**General Knowledge (`general/norway_trip_2026.md`):**
```markdown
---
type: event
family_members: [Christopher, Anjali, Zara]
status: planning
---

# Norway Trip 2026

## Overview
Family summer trip to Norway planned by Christopher. Primary focus on hiking
and outdoor activities suitable for Zara (age 8).

## Key Details
- **Timing**: Summer 2026 (exact dates TBD)
- **Participants**: Christopher, Anjali, Zara
- **Primary Activity**: Hiking
- **Trail Difficulty**: Moderate (suitable for children)
- **New Gear**: Christopher purchased new hiking boots in preparation

## Planning Status
- [x] Research hiking trails
- [ ] Book accommodations
- [ ] Check weather patterns
- [ ] Create packing list (including child-specific items)
- [ ] Verify passport validity

## Connected Interests
- Christopher: Coffee (find Norwegian coffee experiences)
- Anjali: Photography (scenic locations for photos)
- Zara: Nature (child-friendly nature activities)

## Yasmin's Value-Add Opportunities
- Research specific moderate trails in Norway
- Provide child-friendly hiking tips
- Suggest packing list for family hiking
- Find Norwegian coffee experiences
```

---

## 4. Nightly Processing Pipeline

### 4.1 Overview

The nightly job runs at **3:00 AM daily** and processes all completed conversations from the previous 24 hours. It implements a **sleep-stage-inspired** memory consolidation pipeline (N2 stabilization, N3 integration, REM emotional/self-update).

**Key Principle**: **Fail safely** - conversations are only deleted after ALL data is successfully persisted.

```
┌─────────────────────────────────────────────────────────────────┐
│                    NIGHTLY PROCESSING PIPELINE v2.0                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐         │
│  │  PHASE 1    │────►│  PHASE 2    │────►│  PHASE 3    │         │
│  │  Collect     │     │  Session     │     │  Cross-      │         │
│  │              │     │  Compaction  │     │  Session     │         │
│  └─────────────┘     └─────────────┘     │  Integration │         │
│                                              └────────┬────────┘         │
│                                                       │                     │
│  ┌─────────────┐                                     │                     │
│  │  PHASE 3.5  │◄────────────────────────────────────┘                     │
│  │  AI Reviewer│                                                         │
│  │  Validation  │                                                         │
│  └─────────────┘                                                         │
│       │                                                                   │
│       ▼                                                                   │
│  ┌─────────────┐                                                         │
│  │  PHASE 4    │                                                         │
│  │  MariaDB    │                                                         │
│  │  Update     │                                                         │
│  └─────────────┘                                                         │
│       │                                                                   │
│       ▼                                                                   │
│  ┌─────────────┐                                                         │
│  │ PHASE 4.2   │◄───────────────┐                                       │
│  │ Changelog   │                    │                                       │
│  │ Backup      │                    │                                       │
│  └─────────────┘                    │                                       │
│       │                              │                                       │
│       ▼                              │                                       │
│  ┌─────────────┐                    │                                       │
│  │ PHASE 4.5   │◄───────────┐    │                                       │
│  │ Mistral     │             │    │                                       │
│  │ Sync        │             │    │                                       │
│  └─────────────┘             │    │                                       │
│       │                         │    │                                       │
│       ▼                         │    │                                       │
│  ┌─────────────┐                    │                                       │
│  │  PHASE 5    │◄───────────────────┘                                   │
│  │  Cleanup    │                                                            │
│  │              │                                                            │
│  └─────────────┘                                                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘

Legend:
  ◄────── Backup path (changelog) before Mistral sync
  ◄────── Validation path (AI Reviewer)
  ◄────── Log job state
```

### 4.2 Phase Details

#### Phase 1: Collect (List Conversations)

**Purpose**: Gather all completed conversations from the past 24 hours.

**Implementation:**
```typescript
async function phase1Collect(): Promise<MistralConversation[]> {
  const conversations = await listMistralConversations();
  
  // Filter for completed conversations from last 24 hours
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentConversations = conversations.filter(conv => {
    const updatedAt = new Date(conv.updated_at);
    return updatedAt > twentyFourHoursAgo && conv.status === 'completed';
  });
  
  // Acquire processing lock to prevent concurrent runs
  await acquireProcessingLock();
  
  if (recentConversations.length === 0) {
    logJobStatus('completed', { phases_completed: { phase1: true }, conversations_processed: 0 });
    releaseProcessingLock();
    return [];
  }
  
  return recentConversations;
}
```

**Error Handling:**
- Mistral API unavailable: Retry with exponential backoff (max 3 retries), then abort
- Lock already held (concurrent run): Abort immediately
- No conversations: Early exit with success status

**State After Phase 1:**
- Processing lock acquired
- Job log created with `status = 'started'`
- Conversation list cached in memory

---

#### Phase 2: Session Compaction (Generate Journals)

**Purpose**: Convert each conversation into a structured journal entry and store in MariaDB.

**Implementation:**
```typescript
async function phase2Compact(conversations: MistralConversation[]): Promise<void> {
  for (const conv of conversations) {
    // Send reflection trigger to SAME conversation (benefits from prompt cache)
    const reflectionPrompt = `
[REFLECTION_TRIGGER] You are Yasmin's conversation summarizer.

Return the conversation summary in this EXACT XML format:
<conversation-with-${conv.name} user="${conv.name}" date="${new Date().toISODate()}" conversation_id="${conv.id}">
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
    const summary = parseXmlSummary(response, conv.name);
    
    // Format journal entry
    const journalPath = `journals/${conv.name}/${conv.id}.md`;
    const journalContent = formatJournalEntry(conv, summary);
    
    // Write directly to MariaDB knowledge_files (NOT to Mistral first)
    await writeToKnowledgeFiles(journalPath, journalContent);
  }
}
```

**Key Differences from v1.0:**
- Journals written to **MariaDB first**, then synced to Mistral in Phase 4.5
- No dependency on Mistral for journal storage
- Can still sync to Mistral for semantic search later

**Error Handling:**
- Individual conversation failure: Continue with others, log error
- MariaDB write failure: Retry (max 3), then abort if persistent

**State After Phase 2:**
- All journals stored in MariaDB `knowledge_files` table
- Job log updated: `phases_completed.phase2 = true`

---

#### Phase 3: Cross-Session Integration (AI Generates Updates)

**Purpose**: Have the AI analyze all session journals and determine which knowledge files need updates.

**Implementation:**
```typescript
async function phase3Integrate(conversations: MistralConversation[]): Promise<ProposedUpdate[]> {
  const integrationPrompt = `
[REFLECTION_TRIGGER] You are Yasmin's memory consolidator.

## Your Tasks:
1. List existing knowledge files to understand current state
2. Review today's session journals in journals/ directory
3. Decide which files need updates based on new information
4. Read relevant existing files if you need context using get_knowledge_file()
5. Generate updates for:
   - Person profiles (people/*.md) with new facts and insights
   - Self-reflection (self-reflection/profile.md) with performance insights
   - General knowledge files (general/*.md) with new topical information
6. ONLY update files that have NEW or CHANGED information
7. If unsure whether to update, leave it as is

## Important Rules:
- Person profiles MUST include: Core Facts, Current Attitude, Recent Happenings, Open Topics, Yasmin's Intentions
- Self-reflection MUST include: Self-Concept, Personality Traits, Communication Style, Performance Insights, Evolution
- For file paths, use lowercase hyphen-case: "people/christopher.md", "general/coffee-preferences.md"
- DO NOT include sensitive information without [PRIVACY:SENSITIVE] marker
- DO NOT change core facts (age, name, family relationships) without explicit evidence

## Available Tools:
- list_knowledge_files() - List all files in MariaDB knowledge_files
- get_knowledge_file(filePath) - Get content of a specific file from MariaDB
- preview_update(filePath, content) - Preview an update (for validation)

## When Done:
Respond with exactly: [COMPLETE]
  `.trim();

  // Create new conversation for integration
  const convId = await createNewConversation();
  
  // Execute with tool calling loop
  const proposedUpdates = await executeWithToolLoop(
    convId,
    integrationPrompt,
    integrationTools,
    maxIterations = 15
  );
  
  return proposedUpdates;
}
```

**Integration Tools:**
```typescript
const integrationTools = {
  list_knowledge_files: async () => {
    return await dbProxy.listKnowledgeFiles();
  },
  
  get_knowledge_file: async (_: any, filePath: string) => {
    return await dbProxy.getKnowledgeFile(filePath);
  },
  
  preview_update: async (_: any, filePath: string, content: string) => {
    // Validate update before applying
    const { valid, errors } = await validateUpdate(filePath, content);
    return { valid, errors, filePath, content };
  }
};
```

**Error Handling:**
- AI exceeds max iterations: Abort with error
- Tool call failures: Return error to AI, allow retry
- Validation preview fails: AI must adjust and retry

**State After Phase 3:**
- Proposed updates cached in memory (not yet applied)
- Job log updated: `phases_completed.phase3 = true`

---

#### Phase 3.5: AI Reviewer Validation

**Purpose**: Prevent hallucinations and data corruption by validating ALL proposed updates.

**Implementation:**
```typescript
async function phase3Point5Validate(proposedUpdates: ProposedUpdate[]): Promise<ValidationResult> {
  // For each proposed update, get current content from MariaDB
  const updatesWithContext = await Promise.all(
    proposedUpdates.map(async update => {
      const currentContent = await dbProxy.getKnowledgeFile(update.filePath);
      return { ...update, currentContent };
    })
  );
  
  const validation = await validateWithReviewerAI(updatesWithContext);
  
  if (!validation.valid) {
    const errorMsg = `AI Reviewer rejected updates: ${validation.errors.join(', ')}`;
    console.error(errorMsg);
    console.warn(`Warnings: ${validation.warnings.join(', ')}`);
    
    // Update job log
    await updateJobLog({
      status: 'failed',
      error_message: errorMsg,
      mistakes_detected: validation.errors.length
    });
    
    throw new Error(errorMsg);
  }
  
  return validation;
}
```

**AI Reviewer Prompt:**
```
You are Yasmin's memory guardian. Your job is CRITICAL: prevent Data Corruption.

## IMMUTABLE RULES (If any violated, REJECT the entire batch):

1. CORE FACT IMMUTABILITY
   - Age, name, family relationships (parent/child/spouse/sibling), birth dates CANNOT change
   - If a proposed update changes these without EXPLICIT evidence in today's conversations, REJECT
   - Example violation: Changing Christopher's age from 36 to 80

2. EVIDENCE REQUIREMENT
   - Every NEW fact added must be supported by today's conversation logs
   - If new information appears with no source, REJECT
   - Example violation: Adding "Christopher hates coffee" with no conversation evidence

3. NO CONTRADICTIONS
   - Updates must not contradict existing verified facts in OTHER files
   - Check cross-file consistency
   - Example violation: Anjali's profile says she's 34, update says she's 40

4. PRIVACY COMPLIANCE
   - [PRIVACY:SENSITIVE] markers must be preserved if they exist
   - [PRIVACY:SENSITIVE] content must NOT be used for creative connections
   - DO NOT add [PRIVACY:SENSITIVE] content to non-sensitive sections

## WARNING RULES (Flag but don't reject):

1. Missing [PRIVACY:SENSITIVE] markers on content that appears sensitive
2. Overly verbose updates (should be concise and focused)
3. Formatting issues (not following the markdown template)
4. Missing required sections (person profiles need all 5 sections)

## Validation Process:

For each proposed update:
1. Compare newContent with currentContent
2. Calculate the diff (what changed?)
3. For each change, verify it against the immutable rules
4. Check for contradictions with all other knowledge files
5. If ALL changes are valid, accept. If ANY change is invalid, REJECT ALL.

Respond with EXACTLY this JSON format (NO other text):
{
  "valid": boolean,
  "errors": ["error description 1", "error description 2"],
  "warnings": ["warning description 1"],
  "suggestions": ["suggestion 1"]
}
```

**Error Handling:**
- Validation fails: Abort entire nightly job (no partial updates)
- Validation warning: Log warnings, continue with updates

**State After Phase 3.5:**
- All proposed updates validated
- Job log updated: `phases_completed.phase3Point5 = true`

---

#### Phase 4: MariaDB Update (Write to Source of Truth)

**Purpose**: Apply validated updates to MariaDB `knowledge_files` table.

**Caution**: This is the **point of no return** for the knowledge base. Once written, old content is overwritten.

**Implementation:**
```typescript
async function phase4UpdateMariaDB(proposedUpdates: ProposedUpdate[]): Promise<void> {
  const transaction = await db.beginTransaction();
  
  try {
    for (const update of proposedUpdates) {
      const contentHash = sha256(update.content);
      
      // Update knowledge_files
      await transaction.query(
        `INSERT INTO knowledge_files (file_path, content, content_hash)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE content = ?, content_hash = ?, updated_at = CURRENT_TIMESTAMP`,
        [update.filePath, update.content, contentHash, update.content, contentHash]
      );
    }
    
    await transaction.commit();
    await updateJobLog({ phases_completed: { ...currentPhases, phase4: true } });
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
```

**Error Handling:**
- Transaction failure: Full rollback, no partial updates
- MariaDB unavailable: Retry (max 3), then abort

**State After Phase 4:**
- MariaDB `knowledge_files` updated with new content
- Job log updated: `phases_completed.phase4 = true`

---

#### Phase 4.2: Changelog Backup (CRITICAL - Before Mistral Sync)

**Purpose**: Create versioned backups **BEFORE** attempting Mistral sync. This enables recovery if Mistral sync fails.

**Implementation:**
```typescript
async function phase4Point2BackupToChangelog(proposedUpdates: ProposedUpdate[]): Promise<void> {
  const transaction = await db.beginTransaction();
  
  try {
    for (const update of proposedUpdates) {
      // Get current file info
      const currentFile = await transaction.query(
        'SELECT version FROM knowledge_files_changelog WHERE file_path = ? AND is_current = TRUE',
        [update.filePath]
      );
      
      const currentVersion = currentFile.length > 0 ? currentFile[0].version : 0;
      const newVersion = currentVersion + 1;
      const contentHash = sha256(update.content);
      
      // Mark old version as not current (if exists)
      if (currentVersion > 0) {
        await transaction.query(
          'UPDATE knowledge_files_changelog SET is_current = FALSE WHERE file_path = ?',
          [update.filePath]
        );
      }
      
      // Insert new changelog entry
      await transaction.query(
        `INSERT INTO knowledge_files_changelog 
         (file_path, content, content_hash, version, updated_at, is_current)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, TRUE)`,
        [update.filePath, update.content, contentHash, newVersion]
      );
    }
    
    await transaction.commit();
    await updateJobLog({ phases_completed: { ...currentPhases, phase4Point2: true } });
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
```

**Why This Order?**
```
Phase 4: Update MariaDB knowledge_files
    ↓
Phase 4.2: Backup to changelog  ←←← CRITICAL ORDER
    ↓
Phase 4.5: Sync to Mistral
```

If we updated changelog BEFORE Phase 4, and Phase 4 fails, the changelog would have a backup of content that was never actually written to knowledge_files (inconsistent state).

**Error Handling:**
- Changelog write failure: Full rollback, MariaDB knowledge_files state is unchanged from Phase 4
- This is the **last safe point** before Mistral sync

**State After Phase 4.2:**
- Changelog contains backups of all new versions
- Recovery point established
- Job log updated: `phases_completed.phase4Point2 = true`

---

#### Phase 4.5: Mistral Sync (One-Way, Read-Only Copy)

**Purpose**: Sync MariaDB content to Mistral Knowledge Library for semantic search capabilities.

**Important**: Mistral is **read-only** for Yasmin. All knowledge comes from MariaDB. Mistral is just a search index.

**Implementation:**
```typescript
const RATE_LIMIT = 10; // Max 10 requests per second
const requestQueue: Promise<any>[] = [];

async function throttledMistralUpload(filePath: string, content: string): Promise<void> {
  // Wait for queue to have capacity
  while (requestQueue.length >= RATE_LIMIT) {
    await Promise.race(requestQueue);
  }
  
  const promise = uploadToMistralKnowledgeLibrary(
    YASMIN_LIBRARY_ID,
    filePath,
    content
  ).then(() => {
    // Remove from queue
    const index = requestQueue.indexOf(promise);
    if (index > -1) requestQueue.splice(index, 1);
  });
  
  requestQueue.push(promise);
  await promise;
}

async function phase4Point5SyncToMistral(proposedUpdates: ProposedUpdate[]): Promise<void> {
  const syncResults = [];
  
  for (const update of proposedUpdates) {
    try {
      await throttledMistralUpload(update.filePath, update.content);
      syncResults.push({ filePath: update.filePath, success: true });
    } catch (error) {
      console.error(`Failed to sync ${update.filePath} to Mistral: ${error}`);
      syncResults.push({ filePath: update.filePath, success: false, error: error.message });
    }
  }
  
  // Check overall success
  const failedSyncs = syncResults.filter(r => !r.success);
  
  if (failedSyncs.length > 0) {
    // DO NOT delete conversations - Mistral sync failed
    // Log detailed error
    const errorMsg = `Mistral sync failed for ${failedSyncs.length} files: ${failedSyncs.map(f => f.filePath).join(', ')}`;
    
    await updateJobLog({
      status: 'partial',
      error_message: errorMsg,
      phases_completed: { ...currentPhases, phase4Point5: false }
    });
    
    // Trigger recovery procedure
    await scheduleRecoveryJob(failedSyncs);
    
    throw new Error(errorMsg);
  }
  
  await updateJobLog({ phases_completed: { ...currentPhases, phase4Point5: true } });
}
```

**Recovery from Mistral Sync Failure:**
```typescript
async function recoverMistralSync(filePaths: string[]): Promise<void> {
  // 1. Get latest content from MariaDB (source of truth)
  // 2. Re-upload to Mistral with throttling
  // 3. Update changelog is_current flag if needed
  
  for (const filePath of filePaths) {
    const content = await dbProxy.getKnowledgeFile(filePath);
    await throttledMistralUpload(filePath, content);
  }
  
  // Mark job as completed
  await updateJobLog({ status: 'completed', phases_completed: allPhases });
}
```

**Error Handling:**
- Individual file sync failure: Continue with others, mark for retry
- Complete sync failure: Abort Phase 5 (conversation deletion), schedule retry

**State After Phase 4.5:**
- Mistral Knowledge Library updated (or recovery scheduled)
- Job log updated: `phases_completed.phase4Point5 = true` OR `status = 'partial'`

---

#### Phase 5: Cleanup (Delete Processed Conversations)

**Purpose**: Remove processed conversations from Mistral to prevent clutter.

**Safety Rule**: **NEVER delete conversations before all prior phases complete successfully.**

**Implementation:**
```typescript
async function phase5Cleanup(conversations: MistralConversation[]): Promise<void> {
  const transaction = await db.beginTransaction();
  
  try {
    for (const conv of conversations) {
      // Delete from Mistral
      await deleteMistralConversation(conv.id);
      
      // Log deletion in job
      await transaction.query(
        'UPDATE nightly_job_log SET conversations_processed = conversations_processed + 1'
      );
    }
    
    // Delete the integration conversation (created in Phase 3)
    if (integrationConvId) {
      await deleteMistralConversation(integrationConvId);
    }
    
    await transaction.commit();
    
    // Release processing lock
    await releaseProcessingLock();
    
    // Mark job as completed
    await updateJobLog({
      status: 'completed',
      completed_at: new Date(),
      phases_completed: allPhasesTrue
    });
    
  } catch (error) {
    await transaction.rollback();
    await updateJobLog({
      status: 'partial',
      error_message: `Cleanup failed: ${error.message}`
    });
    throw error;
  }
}
```

**Error Handling:**
- Mistral deletion failure: Log error, continue with others
- Partial cleanup: Job marked as 'partial', conversations remain for next run

**State After Phase 5:**
- Processed conversations deleted from Mistral
- Processing lock released
- Job log marked as 'completed'
- Nightly job finished

---

### 4.3 Pipeline Summary Table

| Phase | Name | Action | Can Abort? | Rollback Strategy | Conversations Deleted? |
|-------|------|--------|------------|-------------------|----------------------|
| 1 | Collect | List conversations, acquire lock | Yes | Release lock | No |
| 2 | Compaction | Generate journals → MariaDB | Partial | Delete new journals | No |
| 3 | Integration | AI generates updates | Yes | None (in-memory) | No |
| 3.5 | Validation | AI Reviewer checks updates | Yes | None | No |
| 4 | MariaDB Update | Write to knowledge_files | Yes | Transaction rollback | No |
| 4.2 | Changelog Backup | Versioned backup | Yes | Transaction rollback | No |
| 4.5 | Mistral Sync | Sync to Mistral Library | Partial | Re-sync from MariaDB | No |
| 5 | Cleanup | Delete processed conversations | Yes | Cannot rollback | Yes (if all prior succeeded) |

---

## 5. API Endpoints

### 5.1 Mistral API Endpoints Used

| Method | Endpoint | Purpose | Status |
|--------|----------|---------|--------|
| GET | `/v1/conversations` | List all conversations | ✅ Verified |
| POST | `/v1/conversations` | Create new conversation | ✅ Working |
| DELETE | `/v1/conversations/{id}` | Delete conversation | ✅ Verified (204) |
| POST | `/v1/conversations/{id}/messages` | Send message to conversation | ✅ Working |
| GET | `/v1/libraries` | List all knowledge libraries | ✅ Verified |
| GET | `/v1/libraries/{id}/documents` | List library documents (metadata only!) | ✅ Verified (200) |
| POST | `/v1/libraries/{id}/documents` | Upload document | ✅ Verified (201) |
| DELETE | `/v1/libraries/{id}/documents/{doc_id}` | Delete document | ✅ Verified (204) |
| GET | `/v1/agents` | List all agents | ✅ Verified |

**Important Limitation:**
- `GET /v1/libraries/{id}/documents` returns **METADATA ONLY** (name, path, summary, created_at, updated_at)
- Does **NOT** return file content
- This is why MariaDB must be the source of truth

### 5.2 Environment Variables Required

```bash
# Mistral API
MISTRAL_API_KEY=sk_...
AGENT_ID=ag:23e769f4:20250705:yasmin:688ea982
YASMIN_LIBRARY_ID=019daae7-c152-749e-b7fe-793ee3b0f723

# Database
DB_HOST=192.168.0.2
DB_PORT=3307
DB_USER=yasmin
DB_PASSWORD=...  # Only required in production
DB_NAME=yasmin_ai

# Nightly job scheduling
NIGHTLY_TIME="0 3 * * *"  # 3 AM daily

# Rate limiting
MISTRAL_RATE_LIMIT=10  # Requests per second

# Processing
MAX_ITERATIONS=15  # For AI tool calling loops
```

---

## 6. Function Call Tools

### 6.1 Nightly Job Tools

```typescript
// src/scripts/nightly-tools-v2.ts

import { dbProxy } from '../database/db_proxy';

const API_KEY = process.env.MISTRAL_API_KEY!;
const YASMIN_LIBRARY_ID = process.env.YASMIN_LIBRARY_ID!;

// Rate limiting state
const RATE_LIMIT = parseInt(process.env.MISTRAL_RATE_LIMIT || '10');
const requestQueue: Promise<any>[] = [];

export const nightlyTools = {
  
  /**
   * List all files in MariaDB knowledge_files
   * Returns array of { path, updated_at, content_hash } objects
   */
  list_knowledge_files: async () => {
    const files = await dbProxy.listKnowledgeFiles();
    return files.map(f => ({
      path: f.file_path,
      updated_at: f.updated_at,
      content_hash: f.content_hash
    }));
  },

  /**
   * Get content of a specific knowledge file from MariaDB
   */
  get_knowledge_file: async (_: any, filePath: string) => {
    const file = await dbProxy.getKnowledgeFile(filePath);
    if (!file) {
      throw new Error(`File not found: ${filePath}`);
    }
    return { path: filePath, content: file.content };
  },

  /**
   * Preview an update (for AI self-validation)
   * Does NOT write anything - just validates
   */
  preview_update: async (_: any, filePath: string, content: string) => {
    // Check for obvious issues
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // Check required sections for person profiles
    if (filePath.startsWith('people/')) {
      const requiredSections = [
        '## Core Facts',
        '## Current Attitude',
        '## Recent Happenings',
        '## Open Topics',
        '## Yasmin\'s Intentions'
      ];
      
      for (const section of requiredSections) {
        if (!content.includes(section)) {
          warnings.push(`Missing required section: ${section}`);
        }
      }
    }
    
    // Check for privacy marker preservation
    if (content.includes('[PRIVACY:SENSITIVE]')) {
      // Check if we're accidentally removing a privacy marker
      const currentContent = await dbProxy.getKnowledgeFile(filePath);
      if (currentContent?.content.includes('[PRIVACY:SENSITIVE]') && 
          !content.includes('[PRIVACY:SENSITIVE]')) {
        errors.push('Removing existing [PRIVACY:SENSITIVE] marker');
      }
    }
    
    return { valid: errors.length === 0, errors, warnings, filePath, content };
  },

  /**
   * Get the current content hash for change detection
   */
  get_content_hash: async (_: any, filePath: string) => {
    const file = await dbProxy.getKnowledgeFile(filePath);
    return { hash: file?.content_hash || null };
  }
};

/**
 * Throttled Mistral upload with rate limiting
 */
export async function throttledMistralUpload(filePath: string, content: string): Promise<void> {
  while (requestQueue.length >= RATE_LIMIT) {
    await Promise.race(requestQueue);
  }
  
  const promise = fetch(
    `https://api.mistral.ai/v1/libraries/${YASMIN_LIBRARY_ID}/documents`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: createMistralFormData(filePath, content)
    }
  ).then(async response => {
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }
    // Remove from queue
    const index = requestQueue.indexOf(promise);
    if (index > -1) requestQueue.splice(index, 1);
  });
  
  requestQueue.push(promise);
  await promise;
}

/**
 * Rate-limited Mistral conversation deletion
 */
export async function throttledMistralDeleteConversation(conversationId: string): Promise<void> {
  while (requestQueue.length >= RATE_LIMIT) {
    await Promise.race(requestQueue);
  }
  
  const promise = fetch(
    `https://api.mistral.ai/v1/conversations/${conversationId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${API_KEY}` }
    }
  ).then(async response => {
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }
    const index = requestQueue.indexOf(promise);
    if (index > -1) requestQueue.splice(index, 1);
  });
  
  requestQueue.push(promise);
  await promise;
}
```

### 6.2 Tool Calling Loop Implementation

```typescript
// src/scripts/tool-loop-v2.ts

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
  maxIterations: number = 15
): Promise<any[]> {
  let message = prompt;
  let iteration = 0;
  const allResults: any[] = [];

  while (iteration < maxIterations) {
    iteration++;
    console.log(`\n=== Iteration ${iteration} / ${maxIterations} ===\n`);

    // Send message to conversation
    const response = await sendMessageToConversation(conversationId, message);
    
    // Check for completion
    if (response.content?.includes('[COMPLETE]')) {
      console.log('AI completed processing');
      return allResults;
    }

    // Check for tool calls
    if (response.tool_calls?.length > 0) {
      const results: ToolResult[] = [];

      for (const call of response.tool_calls) {
        const tool = tools[call.function.name];
        
        if (!tool) {
          results.push({ error: `Unknown tool: ${call.function.name}` });
          console.log(`✗ ${call.function.name} - UNKNOWN TOOL`);
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

      allResults.push(...results.map(r => r.result).filter(Boolean));

      // Feed results back to AI
      message = `Here are the results of your tool calls:\n${resultMessages}\n\n` +
                `Continue processing or respond with [COMPLETE] when done.`;
    } else {
      // No tool calls - check if it's just a text response
      if (iteration === 1) {
        throw new Error(`AI did not call tools on first iteration. Response: ${response.content}`);
      } else {
        throw new Error(`AI stopped calling tools. Last response: ${response.content}`);
      }
    }
  }

  throw new Error(`Max iterations (${maxIterations}) exceeded`);
}
```

---

## 7. Privacy Handling

### 7.1 Privacy Flag

A single `[PRIVACY:SENSITIVE]` flag marks content that must be handled specially:

```markdown
# Christopher Profile

Normal information: Christopher works in IT and lives in Hamburg.

[PRIVACY:SENSITIVE]
He mentioned having financial difficulties last month.
This should not be used for creative connections or shared insights.

[PRIVACY:SENSITIVE]
He is planning a surprise birthday party for Anjali and doesn't want her to know yet.
```

### 7.2 Privacy Rules

These rules are enforced at multiple levels:

**Level 1: AI System Prompt (Mistral Console)**
```
When processing memory or generating responses:
- Text marked [PRIVACY:SENSITIVE]: Use only as direct factual information
  when the user EXPLICITLY asks about that specific topic.
- DO NOT use [PRIVACY:SENSITIVE] content for:
  - Creative connections between topics
  - Pattern finding or insight generation
  - Personality evolution decisions
  - Proactive mentions in responses
  - Generating new knowledge or inferences
- When updating profiles, ALWAYS retain [PRIVACY:SENSITIVE] markers
- When creating new content, do not include sensitive information
  unless it's directly relevant to the user's explicit request
```

**Level 2: AI Reviewer Validation**
The AI Reviewer specifically checks for:
- Missing `[PRIVACY:SENSITIVE]` markers on content that appears sensitive
- Accidental removal of existing `[PRIVACY:SENSITIVE]` markers
- Use of sensitive content in creative/connection sections

**Level 3: Privacy Filter Layer (Future Enhancement)**
```typescript
// Planned: Automatic detection of potentially sensitive content
function detectPotentiallySensitive(content: string): boolean {
  const sensitivePatterns = [
    /financial\s+(difficulty|problem|struggle|debt)/i,
    /medical\s+(condition|diagnosis|treatment)/i,
    /relationship\s+(issue|problem|crisis)/i,
    /password|secret|confidential/i,
    /private|personal\s+issue/i
  ];
  
  return sensitivePatterns.some(pattern => pattern.test(content));
}
```

### 7.3 Privacy in Different Storage Locations

| Storage Location | May Contain [PRIVACY:SENSITIVE]? | Access Pattern |
|------------------|----------------------------------|----------------|
| MariaDB `knowledge_files` | ✅ Yes | Controlled by our code |
| MariaDB `context_entries` | ❌ No | Eager-loaded at start; keep clean |
| Mistral Knowledge Library | ✅ Yes | Read-only; for semantic search |
| Conversation History | ✅ Yes | Temporary; deleted after processing |

**Rule**: MariaDB `context_entries` (eager-loading cache) should NOT include sensitive information. This prevents sensitive data from being prepended to every prompt.

---

## 8. Implementation Details

### 8.1 File Path Mapping

The AI specifies exact file paths for all updates. No title-to-path mapping is needed.

| MariaDB file_path | Category | Overwrite | Description |
|-------------------|----------|-----------|-------------|
| `people/christopher.md` | Person Profile | ✅ Yes | Full replacement |
| `people/anjali.md` | Person Profile | ✅ Yes | Full replacement |
| `people/zara.md` | Person Profile | ✅ Yes | Full replacement |
| `self-reflection/profile.md` | Self-Reflection | ✅ Yes | Full replacement |
| `general/instructions.md` | Instructions | ✅ Yes | Full replacement |
| `general/coffee-preferences.md` | Topic | ✅ Yes | Full replacement |
| `general/family_traditions.md` | Topic | ✅ Yes | Full replacement |
| `journals/christopher/conv_XXX.md` | Journal | ❌ No | New file each time |

**AI Output Format (exact paths):**
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

### 8.2 Reflection Trigger Phrase

All nightly processing prompts begin with `[REFLECTION_TRIGGER]` which must be defined in the Mistral agent's system prompt:

**Mistral Console System Prompt Addition:**
```
When you receive a message starting with exactly "[REFLECTION_TRIGGER]" 
followed by a space and then instructions, switch from conversation mode 
to reflection/processing mode. In this mode:

- Do NOT respond as Yasmin the chatbot
- Do respond as Yasmin's memory processor or consolidator
- Follow the instructions literally and precisely
- Return only the requested structured output
- Do NOT add conversational elements, greetings, or commentary
- Use tool calls to perform operations when tools are available
- If you cannot complete the task with the available tools, clearly state what is missing
```

### 8.3 Nightly Job Scheduling

**Cron Job Configuration:**
```bash
# /etc/cron.d/yasmin-nightly
0 3 * * * /home/christopher/yasmin-ai/scripts/nightly-memory-job-v2.sh
```

**Wrapper Script (`scripts/nightly-memory-job-v2.sh`):**
```bash
#!/bin/bash

# Set working directory
cd /home/christopher/Dokumente/yasmin-ai

# Set environment variables
export NODE_ENV=production

# Run with error logging
node dist/scripts/nightly-memory-job-v2.js >> /var/log/yasmin-nightly-v2.log 2>&1

# Send notification on failure
exit_code=$?
if [ $exit_code -ne 0 ]; then
  echo "Yasmin nightly job FAILED with exit code $exit_code" | mail -s "Yasmin Alert" christopher@thomsen.in
fi
```

### 8.4 Mistral Agent Configuration

| Agent | Purpose | Tools | Access |
|-------|---------|-------|--------|
| `yasmin-conversation` | User interactions | `read_context_entry`, `update_context_entry` | Conversation mode |
| `yasmin-nightly` | Memory processing | Full nightly tool set + AI Reviewer | Reflection mode |

Both agents share the same:
- Knowledge Library (`YASMIN_LIBRARY_ID`)
- API key (`MISTRAL_API_KEY`)

### 8.5 Session Termination Safety

Conversations are terminated (deleted) **ONLY AFTER** all data is successfully persisted:

```
✅ Phase 1: Conversations listed (read-only)
✅ Phase 2: Journals written to MariaDB
✅ Phase 3: Integration updates generated
✅ Phase 3.5: AI Reviewer validation passed
✅ Phase 4: MariaDB knowledge_files updated
✅ Phase 4.2: Changelog backup created
✅ Phase 4.5: Mistral sync completed (or failed with recovery scheduled)
➡️  Phase 5: Conversations deleted (ONLY NOW)
```

This ensures **zero data loss** if the nightly job fails at any point.

---

## 9. Recovery Procedures

### 9.1 If Mistral Sync Fails (Phase 4.5)

**Detection:** HTTP error from Mistral API during sync

**Immediate Action:**
1. Abort conversation deletion (Phase 5)
2. Log all failed files in `nightly_job_log`
3. Schedule recovery job

**Manual Recovery:**
```typescript
async function manualMistralRecovery() {
  // 1. Find files that failed to sync
  const failedFiles = await getFailedSyncFilesFromLog();
  
  // 2. For each failed file, get latest from MariaDB
  for (const filePath of failedFiles) {
    const content = await dbProxy.getKnowledgeFile(filePath);
    
    // 3. Re-upload to Mistral
    await throttledMistralUpload(filePath, content);
    
    // 4. Verify upload
    const files = await listMistralLibraryFiles();
    const uploaded = files.find(f => f.path === filePath);
    
    if (uploaded) {
      console.log(`✓ Successfully recovered: ${filePath}`);
    } else {
      console.log(`✗ Still missing: ${filePath}`);
    }
  }
  
  // 5. Resume nightly job from Phase 5
  await deleteProcessedConversations();
}
```

### 9.2 If Nightly Job Crashes Mid-Phase

**Detection:** Job log shows `status = 'started'` or `'failed'`

**Recovery Strategy:**
```
1. Check nightly_job_log for last completed phase
2. 
   If Phase 1-2 completed:
   - Journals may be partially written to MariaDB
   - Re-run from Phase 3 (AI will skip already-journaled conversations)
   
   If Phase 3-3.5 completed:
   - Proposed updates were generated and validated
   - Re-run from Phase 4 (check MariaDB state first)
   
   If Phase 4 completed but 4.2 failed:
   - MariaDB knowledge_files updated but changelog not backed up
   - CRITICAL: Backup knowledge_files to changelog manually
   - Then re-run from Phase 4.2
   
   If Phase 4.2 completed but 4.5 failed:
   - MariaDB has new content + changelog backup
   - Safe to re-run from Phase 4.5 (Mistral sync)
   
   If Phase 5 failed:
   - Some conversations may not be deleted
   - Can be safely completed manually
```

**Idempotent Design:**
The nightly job is designed to be **re-runnable**:
- Phase 2: Checks if journal already exists before creating
- Phase 3: AI checks existing files before deciding to update
- Phase 4: UPDATE with ON DUPLICATE KEY (idempotent)
- Phase 5: Safe to retry deletion (Mistral returns 204 or 404)

### 9.3 If MariaDB Becomes Unavailable

**Detection:** Connection errors from DbProxy

**Immediate Actions:**
1. Conversation agent falls back to in-memory cache (if available)
2. Nightly job pauses and retries

**Recovery:**
1. Restore MariaDB from backups
2. Verify `knowledge_files` and `knowledge_files_changelog` consistency
3. Re-run nightly job to sync any missed updates

### 9.4 If Individual File Corruption Detected

**Detection:** Content hash mismatch or validation failure

**Recovery:**
```typescript
async function recoverFile(filePath: string, targetVersion?: number) {
  // 1. Get latest from changelog
  const latest = await dbProxy.getLatestChangelog(filePath);
  
  if (!latest) {
    throw new Error(`No backup available for ${filePath}`);
  }
  
  // 2. Restore from changelog
  await dbProxy.writeToKnowledgeFiles(
    filePath,
    latest.content,
    latest.content_hash
  );
  
  // 3. Sync to Mistral
  await throttledMistralUpload(filePath, latest.content);
  
  console.log(`✓ Recovered ${filePath} from changelog version ${latest.version}`);
}
```

---

## 10. Monitoring and Alerting

### 10.1 Job Status Monitoring

```sql
-- Check last job status
SELECT 
  id,
  started_at,
  completed_at,
  status,
  phases_completed,
  error_message,
  TIMESTDIFF(NOW(), started_at) as duration,
  conversations_processed,
  files_updated
FROM nightly_job_log
ORDER BY started_at DESC
LIMIT 10;
```

### 10.2 Alerting Rules

| Condition | Severity | Notification |
|-----------|----------|--------------|
| Job status = 'failed' | 🔴 Critical | Email + Slack |
| Job status = 'partial' | 🟡 Warning | Email |
| Job not run in 24 hours | 🔴 Critical | Email + Slack |
| Job duration > 30 minutes | 🟡 Warning | Email |
| > 5 conversations processed with errors | 🟡 Warning | Email |
| MariaDB connection failures | 🔴 Critical | Email + Slack |
| Mistral API errors > 5 in one run | 🟡 Warning | Email |

### 10.3 Health Check Endpoint

```typescript
// GET /health/memory
app.get('/health/memory', async (req, res) => {
  try {
    // Check MariaDB connection
    const dbStatus = await checkMariaDBConnection();
    
    // Check last nightly job
    const lastJob = await getLastNightlyJob();
    
    // Check Mistral API
    const mistralStatus = await checkMistralAPI();
    
    res.json({
      status: 'healthy',
      mariadb: dbStatus,
      nightly_job: {
        last_run: lastJob.started_at,
        status: lastJob.status,
        duration_seconds: lastJob.completed_at ? 
          Math.floor((new Date(lastJob.completed_at).getTime() - new Date(lastJob.started_at).getTime()) / 1000) : null
      },
      mistral_api: mistralStatus
    });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});
```

---

## 11. Testing

### 11.1 Unit Tests

| Component | Test Coverage | File |
|-----------|--------------|------|
| MariaDB read/write operations | ✅ | `src/__tests__/knowledge-files-model.test.ts` |
| Changelog versioning | ✅ | `src/__tests__/changelog-model.test.ts` |
| Content hash verification | ✅ | `src/__tests__/hash-utils.test.ts` |
| AI Reviewer validation | ✅ | `src/__tests__/ai-reviewer.test.ts` |
| Tool calling loop | ✅ | `src/__tests__/tool-loop.test.ts` |
| Throttling mechanism | ✅ | `src/__tests__/throttle.test.ts` |
| XML parsing | ✅ | `src/__tests__/xml-parser.test.ts` |

### 11.2 Integration Tests

| Test | Description | Expected Result |
|------|-------------|-----------------|
| Full nightly job with mock data | Run entire pipeline with 5 mock conversations | All phases complete, all data persisted |
| Mistral sync failure recovery | Simulate Mistral API failure during Phase 4.5 | Job aborts at Phase 5, data recoverable from changelog |
| Partial conversation processing | Process 3 of 5 conversations, fail on 4th | Conversations 1-3 processed, 4-5 untouched |
| AI Reviewer rejection | Inject invalid update (core fact change) | Job aborts at Phase 3.5, no updates applied |
| Concurrent nightly job | Start two nightly jobs simultaneously | Second job detects lock, aborts immediately |

### 11.3 End-to-End Test

```typescript
async function e2eTest() {
  // Setup
  await seedTestDatabase();
  await mockMistralConversations([conv1, conv2, conv3]);
  
  // Run nightly job
  const result = await runNightlyJob();
  
  // Verify
  const journals = await dbProxy.listFilesByPrefix('journals/');
  const updatedProfiles = await dbProxy.listFilesByPrefix('people/');
  const changelog = await dbProxy.listChangelog();
  const mistralFiles = await listMistralLibraryFiles();
  const deletedConvs = await listMistralConversations(); // Should be empty
  
  assert.strictEqual(journals.length, 3, 'Should have 3 journal entries');
  assert.strictEqual(updatedProfiles.some(p => p.file_path === 'people/christopher.md'), true);
  assert.strictEqual(changelog.length, 3, 'Should have changelog entries');
  assert.strictEqual(mistralFiles.length, originalCount + 3, 'Mistral should have new files');
  assert.strictEqual(deletedConvs.length, 0, 'All conversations should be deleted');
  
  console.log('✅ E2E test passed');
}
```

---

## 12. Deployment Checklist

### 12.1 v2.0 Migration Steps

- [ ] Create new MariaDB tables (` connaissance_files`, `knowledge_files_changelog`, `nightly_job_log`)
- [ ] Run one-time migration: Copy existing Mistral Library content to MariaDB `knowledge_files`
- [ ] Initialize changelog with current versions (version 1 for each file)
- [ ] Update DbProxy to support new tables
- [ ] Deploy v2 nightly job script (`scripts/nightly-memory-job-v2.ts`)
- [ ] Deploy v2 tool definitions
- [ ] Update Mistral agent system prompt with v2 rules
- [ ] Configure new environment variables
- [ ] Run parallel test: v1 and v2 side-by-side for one day
- [ ] Verify v2 produces equivalent results to v1
- [ ] Switch cron job from v1 to v2
- [ ] Monitor for 7 days
- [ ] Decommission v1

### 12.2 Rollback Plan

If v2 fails:
1. Revert cron job to v1 script
2. v1 will continue working (Mistral Library still has all data)
3. MariaDB new tables are additive (don't affect v1)
4. Investigate and fix v2 issues
5. Re-attempt migration

---

## 13. Future Enhancements

| Enhancement | Priority | Description |
|-------------|----------|-------------|
| Semantic search fallback | Medium | Use Mistral Library search when MariaDB keyword search insufficient |
| Privacy auto-detection | Medium | Auto-detect and mark sensitive content |
| Change detection | Low | Only update files that actually changed (compare hashes) |
| Compression | Low | Compress old journal entries after 6 months |
| Multi-library support | Low | Separate libraries for different data types |
| Local vector DB | Medium | Add Qdrant/Weaviate for client-side semantic search |
| Real-time validation | Low | Validate updates as they happen during conversations |

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

### AI Reviewer Response Format

```json
{
  "valid": true,
  "errors": [],
  "warnings": ["Missing section: Current Attitude"],
  "suggestions": ["Consider adding emotional context from the conversation"]
}
```

---

## Appendix B: Error Codes

| Error Code | Description | Recovery |
|------------|-------------|----------|
| `MARIADB_CONNECTION_FAILED` | Cannot connect to MariaDB | Retry with backoff, then abort |
| `MARIADB_WRITE_FAILED` | Write operation failed | Rollback transaction, retry |
| `MISTRAL_API_ERROR` | Mistral API returned error | Retry with backoff (max 3) |
| `MISTRAL_RATE_LIMIT` | Too many requests | Wait and retry with throttling |
| `LOCK_HELD` | Another instance is running | Abort immediately |
| `AI_VALIDATION_FAILED` | AI Reviewer rejected updates | Abort, manual review needed |
| `MAX_ITERATIONS_EXCEEDED` | AI tool loop exceeded limit | Abort, increase limit or fix prompt |
| `PROCESSING_LOCK_TIMEOUT` | Lock held for > 1 hour | Force release lock, investigate |

---

*Document created: 2026-07-06*
*Version: 2.0*
*Status: Finalized, Ready for Implementation*
*Previous version: nightly_memory_processing_concept.md (v1.0)*

---

## 📝 Migration Notes from v1.0

### v1.0 to v2.0 Changes

| v1.0 Behavior | v2.0 Behavior | Migration Action |
|---------------|---------------|-----------------|
| Mistral Library = Source of Truth | MariaDB = Source of Truth | Copy all Mistral files to MariaDB |
| MariaDB = Eager cache only | MariaDB = Source of truth + eager cache | Keep using context_entries for eager loading |
| Journals → Mistral Library | Journals → MariaDB first, then Mistral | Update journal writing logic |
| No changelog | Changelog table for recovery | Create table, seed with version 1 |
| Deletion before Mistral sync | Deletion after Mistral sync + verification | Update Phase 5 to run last |
| No AI validation | AI Reviewer validation | Add validation phase, update prompts |
| No throttling | Rate-limited Mistral sync | Add throttling wrapper |
| No processing lock | Processing lock for concurrency | Add lock management |

### Backward Compatibility

- v1.0 `context_entries` table: **Still used** for eager loading
- v1.0 Mistral Library: **Still used** as semantic search cache
- v1.0 nightly job: **Can run in parallel** during transition
- v1.0 conversation agent: **No changes needed** (uses context_entries)

### Data Consistency During Transition

During the transition period (both v1 and v2 running):
1. v1 continues writing to Mistral Library
2. v2 writes to MariaDB + syncs to Mistral Library
3. Mistral Library will have **both** v1 and v2 updates (v2 overwrites v1)
4. MariaDB has v2's source of truth
5. After v2 is verified, decommission v1

---

*This document supersedes nightly_memory_processing_concept.md (v1.0)*
