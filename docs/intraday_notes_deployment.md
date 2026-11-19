# Cross-Person Notes (intraday_notes) — Deployment Checklist

**Status**: developer-actionable, manual ops steps for deploying the `share_note` feature (issue #46)

The `intraday_notes` table is the live agent's cross-person note cache: notes staged via the
`share_note` tool are delivered — exactly once per recipient — with the recipient's next user
input, and the nightly job consolidates still-undelivered notes and resets the table once a day.
See `docs/ARCHITECTURE.md`, "Cross-person notes: the intraday_notes cache" for the design.

---

## 1. Apply the database table before deploying the code

Apply the `intraday_notes` table from `database/schema.sql` to the database **before** deploying
the code — otherwise every `share_note` call and every note lookup on prompt build fails.
Failures are non-fatal (the chat keeps working, notes simply stay undelivered), but the feature
is dead until the table is in place.

## 2. Mistral Studio

1. **Live conversation agent** (not the nightly one): register the `share_note` tool on the
   agent (definition in `mistral_config/conversation/functions/share_note.json`).
2. **Live conversation agent**: update its system prompt to the current
   `mistral_config/conversation/system_prompt.txt` (it carries the share_note usage rules and
   the privacy barrier — the live agent is the only filter between sender and recipient).

## 3. Verify

1. Ask the agent to tell another person something (e.g. "Tell Zara to be home by 6 pm"), then
   confirm the row in `intraday_notes`.
2. Message as that person and check for the `<nachrichten_fuer_dich>` block in the server log.
3. An "everyone" note must never be delivered back to its own sender (the delivery query
   filters `from_username != ?`).

## Nightly snapshot and reset

Immediately after collecting conversations (Phase 1), the pipeline captures `MAX(id)` over **all**
notes, including delivered rows, then reads undelivered notes up to that bound. The early snapshot
lets undelivered notes prevent the empty-batch skip. A note staged mid-run above that bound is
neither consolidated nor deleted: it survives for the next run. Phase 8 deletes only up to the
snapshot bound after integration and review/archive succeeded; a failed snapshot read prevents
the reset. Using the undelivered subset's maximum instead would leave a delivered-only outbox
with a zero bound, so those rows would never be cleared on a non-skipped run.

The empty-batch skip applies to fresh and resumed runs. An orphaned job with no recorded
conversation IDs is collected again using the same job row, since a crash may have happened before
the ID list was persisted; only an empty effective batch with no known undelivered notes skips.
The skip performs no outbox reset (even if the notes read failed), leaving unknown pending notes
and inert delivered rows untouched until a later non-skipped run.

## Known gotcha: existing conversations keep the old toolset

Mistral pins an agent's tools at conversation creation time. Conversations started **before**
the `share_note` registration will never call the tool, no matter what the agent definition
says now — and the server keeps routing to them for up to `conversationTtlMs` (12 h), or until
the nightly job deletes them. The same applies to system-prompt changes.

If the tool needs to work immediately after registration, delete the affected user's active
conversation in Mistral Studio (the nightly job deletes consolidated conversations anyway, so
this is a normal operation) or temporarily set `MAX_TURNS_PER_SESSION=1` and restart the server
so the very next message starts a fresh conversation. Otherwise it self-heals within 12 h.
Verify with a fresh conversation: the agent should emit a `share_note` tool call.

## Rollback

Redeploying the previous code and restoring the previous agent definition (system prompt and
tool registration) in Mistral Studio fully disables the feature. The `intraday_notes` table can
simply be dropped (`DROP TABLE intraday_notes`); no other table or memory data references it.
