# Context Conventions

This document outlines the naming conventions and architectural separation between **Static Context** and **Dynamic Context** in Yasmin AI's knowledge base.

---

## 1. Context Groups Overview

The assistant's context is separated into two groups to achieve high accuracy, minimize token bloat, and avoid cross-language keyword mismatch (e.g., matching "Interessen" to "interests" via TF-IDF).

```
                      ┌────────────────────────────────────────┐
                      │             Context System             │
                      └───────────────────┬────────────────────┘
                                          │
                  ┌───────────────────────┴───────────────────────┐
                  ▼                                               ▼
      ┌───────────────────────┐                       ┌───────────────────────┐
      │  Static Grounding     │                       │  Dynamic Memories     │
      │  (Eagerly Loaded)     │                       │  (Tool-Called/Lazy)   │
      └───────────┬───────────┘                       └───────────┬───────────┘
                  │                                               │
      ┌───────────┼───────────┐                       ┌───────────┼───────────┐
      ▼           ▼           ▼                       ▼           ▼           ▼
   Yasmin      Family       Sender                 Journals   Interests    Topics
 Background   Relations   Background
```

---

## 2. Static Grounding Group (Eagerly Loaded)

These entries represent critical, unchanging facts that the assistant must have immediate access to on the first turn of any chat session. They are **eagerly loaded** into the system prompt once per conversation and cached.

### Naming Pattern

All static entries start with the prefix **`Background on [Subject]`** (case-insensitive).

### Static Entries List

| Title                          | Description / Content                                       | Loading Behavior               |
| :----------------------------- | :---------------------------------------------------------- | :----------------------------- |
| **`Background on Yasmin`**     | Yasmin's age, location, identity, personality, and tone.    | Mandatory on the initial turn. |
| **`Background on the Family`** | The complete family tree and relationships mapping.         | Mandatory on the initial turn. |
| **`Background on [User]`**     | The sender's specific age and exact relationship to Yasmin. | Mandatory on the initial turn. |

---

## 3. Dynamic Memories Group (On-Demand / Lazy Loaded)

These entries represent changing user preferences, journals of past conversations, and topics. Rather than being loaded automatically, they are **lazily queried** by Yasmin herself using Mistral Tool Calling (`read_context_entry`).

This entirely bypasses TF-IDF language matching issues. Since Yasmin understands German, if a German user asks _"Was sind meine Interessen?"_, Yasmin will decide to execute the tool with the argument `title="Interests of [User]"`.

### Patterns & Grouping

#### A. Interests & Preferences

- **Pattern**: `Interests of [User]`
- **Purpose**: Storing hobbies, likes, dislikes, favorite programming languages, and topics of interest.
- **Example**: `Interests of Jonas`
- **Content Example**: _"Jonas loves coding in Python and building CLI tools, but dislikes CSS."_

#### B. Journals (Interaction History)

- **Pattern**: `Journal with [User]`
- **Purpose**: Broad summaries of past conversations and milestones learned about the user.
- **Example**: `Journal with Christopher`
- **Content Example**: _"Christopher is planning a surprise party for Zara's next birthday. He wants to keep it a secret."_

#### C. Topics to Discuss

- **Pattern**: `Topics for [User]`
- **Purpose**: Ongoing questions or threads that Yasmin should proactively bring up with the user next time they talk.
- **Example**: `Topics for Samira`
- **Content Example**: _"Ask Samira how her first day at kindergarten was and if she made new friends."_

---

## 4. How the AI Decides to Load Dynamic Context

When a user initiates a conversation, Yasmin is grounded with the **Static Group** (she knows who she is talking to and how they are related).

If she needs more information about hobbies, interests, or past interactions, she calls the following tool:

### Tool Definition: `read_context_entry`

- **Description**: Retrieves the content of a context entry from the database based on the exact title.
- **Parameters**:
  - `title` (string): The exact title of the context entry to retrieve (e.g. `Interests of Christopher`, `Journal with Zara`).

Because she knows the exact naming conventions above, she can confidently construct the required title dynamically in any language!
