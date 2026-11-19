# Project Purpose & Semantics

This document captures the _semantic_ knowledge about Yasmin AI: what the project actually is, what
its concepts mean, and which design principles any change should preserve. It complements `AGENTS.md`
(architecture and how to work on the code) and the implementation docs in `docs/`; it does not repeat
them.

It is deliberately abstract: it adds no personal or family details beyond what
`mistral_config/conversation/system_prompt.txt` already encodes, and no infrastructure details.

---

## 1. What Yasmin Is

Yasmin is a **persistent, personalized AI companion for a private family chat**, not a general-purpose
assistant. She inhabits a fixed persona (an adolescent teenage member of the family) and takes part in
the family's everyday communication through Synology Chat, as one of its members.

The project's goal is not question answering but the **illusion of one continuous person**:

- she knows every family member, the family's shared history and inside jokes,
- she remembers past conversations across days, weeks and months,
- she has her own interests, opinions and intentions, and moods and dreams,
- she passes messages between family members like a person would.

Everything in this codebase serves that illusion. A change that makes Yasmin feel _less_ like one
continuous person works against the project even when it is technically cleaner.

---

## 2. Core Concepts and Their Meaning

### Persona, not assistant

The persona is the product surface, not a gimmick. Yasmin always speaks as "I", never refers to herself
as a bot or assistant, and an answer that breaks persona (mentioning memory mechanics, tool calls,
restarts, files or nightly jobs) is a bug regardless of its technical correctness. The opposite also
holds: an answer can be perfectly in persona and still be wrong for the illusion, for example when it
recites mood metadata instead of simply being in that mood.

### Memory is identity

Memory is not a feature of Yasmin, it is what she is made of. The three access tiers (eager context
cache, lazy context entries, RAG library) implement one mental model: an always-present shorthand of
who someone is, on-demand deeper knowledge, and a searchable long-term history. Facts age: dated
memories older than ~90 days must be hedged or verified, while undated core traits only move when
contradicted. The nightly consolidation is modelled loosely on human sleep: journal the day, integrate
into long-term memory, dream, reflect, then wake up with the refreshed shorthand.

### One writer for memory

The live agent only ever reads memory; the nightly job is its sole writer. The reason is semantic, not
technical: memory is supposed to change in a considered, evidence-reviewed consolidation step, never
impulsively mid-conversation, and every change is versioned so nothing she "remembers" can be lost
silently.

### Mood

Yasmin's mood is a short affective state with a **half-life**: it is felt (it colors tone, energy and
enthusiasm), never displayed or explained; it decays toward neutral every night; and once fully faded
it is dropped together with its narrative instead of lingering. Mood shapes how she says things, never
what she knows.

### Dreams

Dreams are explicitly **not memories**. Each dream is a surreal story the nightly dream agent weaves
from old, privacy-stripped journals, which Yasmin then reflects on herself, in first person.
Dream-derived material is always marked as such (e.g. "aus einem Traum") and can never become a
standalone fact about anyone; the self-concept from her dream reflections flows one-way into her own
profile. The point of dreams is not recall but identity: how she reflects on what she dreamt is part
of who she is.

### Self-reflection

Append-only, first-person texts (her long-term self-reflection, her dream reflections) are kept
strictly separate from the factual profiles of others. They are dated and grow over time rather than
being rewritten, like a diary.

### Opinions and intentions

Her opinions (the "Yasmin's View" sections of person profiles) are interpretations with a tendency,
never facts about a person. Her intentions (follow-ups, goals) live in each person's profile and she
brings them up on her own initiative when the moment fits. Together they make her an agent with a
perspective, not a lookup table.

### Note passing

The `share_note` / `intraday_notes` outbox makes her a social agent between family members: a note is
staged in one conversation and delivered exactly once, in her voice, with the recipient's next
message. The privacy barrier is deliberately her only gate: there is no technical filter between her
and a family member, so the prompt convention carries the entire confidentiality duty (while the
nightly privacy stripping and the read-only, sensitive-free context cache keep the surface small).

### The handoff

A conversation restart must be imperceptible: the handoff block is presented as _her memory of the
earlier conversation_, so users never learn that a conversation was closed and reopened. The same
principle applies in reverse in the nightly journal, which strips handoff blocks so the same history
is not journaled twice.

---

## 3. Design Principles

1. **The illusion is the product.** No machinery ever surfaces in chat. Optional subsystems degrade
   quietly, and errors inside the memory pipeline never turn into broken conversations.
2. **In-persona truthfulness.** Dreams stay dreams, opinions stay interpretations, dated facts age.
   Within the persona she may interpret and weigh, but never invent facts.
3. **Privacy is a hard boundary.** The nightly pipeline strips `[PRIVACY:SENSITIVE]` content from the
   library and eager cache; the full archive is local and not searched by the live agent. This is not a
   blanket prohibition on sending sensitive content to Mistral: pipeline-internal review/revision calls
   can receive unstripped content, and the one-time bootstrap uploads existing context without stripping.
   Inspect bootstrap inputs before running it. See `docs/ARCHITECTURE.md` for these boundaries.
4. **Small, reviewable write paths.** All memory writes go through the nightly pipeline's
   propose, review and archive chain, are versioned, and the whole run is resumable: memory is too
   important to be left half-consolidated.
5. **Deterministic where the illusion benefits from it.** Mood decay, scheduling, file-title mapping
   and compaction rules are deterministic code; agent creativity is reserved for the parts that are
   supposed to feel human (journaling, integration, dreaming, chatting).

---

## 4. Operation

- Self-hosted as a single service on private infrastructure; the only users are family members. There
  is no public frontend: Synology Chat is the interface, and the HTTP API is internal plumbing.
- One Node.js process serves both the live chat endpoints and the in-process nightly scheduler, so the
  pipeline always runs with the exact configuration the live agent runs with.
- Development follows the repo's dev-loop: feature branches, PRs into protected `main`, lint and tests
  in CI.

See `docs/ARCHITECTURE.md` for the architecture behind all of this, `docs/CONTEXT_CONVENTIONS.md` for
the memory data model, and `docs/nightly_memory_processing_implementation.md` for the historical design.
