# Dev Loop on GitHub Actions + Mistral Vibe — Implementation Plan

Successor design to PR #80 (`.openclaude/` skill/agents/guard): GitHub Actions replaces the
orchestrator (no cron tick, no `state.json`, no command-text guard); the agentic work
(implement / review / fix, including merge-conflict resolution) stays with a real coding-agent
harness — Mistral models via OpenCode — executed headless on the workflow runner, with its
full local toolset (edit files, `npm run build`, `npm test`, `npm run lint`, `npx prettier`).

GitHub is the source of truth (issues, PRs, reviews, labels). The loop is fully event-driven:
every dispatch follows a GitHub event; the chain is usually the GitHub event the previous
role's push fires — direct workflow chaining is the deliberate exception, not the rule (see
the enumeration in Non-events by design).

## Architecture

```
GitHub event
        │
        ▼
role workflow (reviewer / fixer / implementer)
  pre-step: gate + dedupe (dev-loop label, draft, needs-human, head SHA, iteration cap)
  job:      checkout → Node 22 → npm ci → render prompt (budget injected) →
            timeout --signal=TERM --kill-after=60 <time-limit> opencode run --standalone
            --format json --auto --model mistral/zai-glm-5-3 "$(cat out/<role>.rendered.md)"
            (with a failure-streak / step / token watchdog on the stream)
  post-step: deterministic state machine from out/stream.ndjson + out/opencode.stderr
             (labels, escalation, failure classification)
```

Agents never change PR state (draft/ready/labels) themselves: every state transition is a
workflow post-step, auditable in the run log, enforceable in code. There is **no draft/ready
state machine**: the loop does not flip PRs between draft and ready. Draft status is a human
parking brake — draft PRs are simply never touched by the loop.

## Opt-in: the `dev-loop` label

The loop is opt-in, not opt-out. No workflow touches an issue or PR unless it carries the
`dev-loop` label. The label is the first gate line in every workflow, evaluated before all
other checks; if the label is absent, the run skips without side effects. Adding the label to
an existing issue or PR starts the loop (`labeled` trigger); removing it stops the loop from
picking the item up on future events.

## Event map (final, agreed)

| Trigger                                                                                                           | Fires                                                  | Guard / notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issues: [opened, reopened, labeled]`                                                                             | implementer                                            | requires `dev-loop` label; skip if a `vibe/issue-<N>-*` branch exists; `labeled: dev-loop` starts the loop on an existing issue. `needs-human` on an issue is informational only (parking = removing `dev-loop`, resume = re-adding it); there is no `unlabeled` trigger and no `needs-human` gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pull_request: [opened, ready_for_review, synchronize, labeled, unlabeled]`                                       | reviewer                                               | skip if draft, or no `dev-loop` label, or `needs-human`; marker-dedupe on head SHA; **CI gate**: poll the head's check runs (bounded, fail open) — green + tip unchanged → review; red + tip unchanged → dispatch the fixer (no-findings CI-failure run) and skip; tip moved (e.g. `chore: auto-format` pushed by ci.yml) → skip, the push's `synchronize` re-offers on the new head. `opened`/`labeled` cover the implementer's ready PR (created non-draft, label added right after) and human opt-in on an existing PR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pull_request_review: [submitted]`                                                                                | fixer                                                  | event payload gate, partitioned by review author AND shape (reviews are world-postable on a public repo, so the author is checked on both branches; the expected login is derived from `github.repository_owner`, not hardcoded - the repo owner is the human by definition): **owner-authored marker review** (`<!-- dev-loop-review -->` line 1) with `Verdict: CHANGES_NEEDED` → fixer, CLEAN/NEEDS_HUMAN → nothing; **owner-authored `COMMENT` review** (state matched case-insensitively: the webhook payload delivers lowercase, only the REST API returns uppercase) with a non-empty body → fixer treats body + inline comments as the human's findings (the owner cannot APPROVE/REQUEST_CHANGES on their own PRs - the loop opens PRs under the owner's PAT - so a comment review is the human's findings channel; informational reviews get replies and no push; owner APPROVE/CHANGES_REQUESTED bodies, possible on human-authored PRs opted into the loop, dispatch nothing); **empty-body submissions** (the fixer's own reply reviews and an owner's comment-only reviews alike - the job-level `if` cannot distinguish fresh threads from replies, so both are filtered) → nothing, pre-filtered by a job-level `if` before runner allocation (also prevents the fixer's own replies from cancelling a pending re-review, the PR #106 race; a human findings review must carry body text - see Human input channels); third-party reviews → nothing (injection surface: a forged marker shape by a non-owner starts nothing). The shape contract is load-bearing: every automated review must carry either the marker or an empty body - the fixer prompt forbids body-carrying review submissions by the fixer itself   |
| (reviewer's CI gate, red dispatch) `pull_request: [synchronize]` with red/failed checks on a `CONFLICTING` head   | fixer (no-findings run: conflicts and/or failing CI)   | conflict origin 1: the PR's own push made it conflicting - a conflicted head cannot produce green checks, so the reviewer's CI gate dispatches the fixer (one per head SHA). The fixer has **no** `synchronize` trigger of its own: it would race the reviewer for the shared `dev-loop-pr-<N>` concurrency slot on every fix push and cancel the pending re-review (observed on PR #106)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `push: [main]` + scan of open dev-loop PRs for `mergeable == CONFLICTING`                                         | fixer (conflict-only runs, dispatched)                 | conflict origin 2: `main` moved under a ready PR; one scan per merge, one dispatch per conflicting PR (`review_id=none` sentinel; `UNKNOWN` mergeability re-listed boundedly, leftovers dispatched and re-checked live)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pull_request: [unlabeled]` on `needs-human`                                                                      | resume (PRs only)                                      | fires BOTH the reviewer and the fixer (both list `unlabeled`): the reviewer re-reviews with a fresh budget, the fixer re-fixes the latest findings review. Both contend for the shared group's single running slot: the resume reviewer pends behind the running resume fixer, and any later shared-group entrant displaces a pending run (PR #115: the fixer's unchanged-head-FIXED chain dispatch displaced the pending resume reviewer ~3.5 min in; the chained run did review the head, so only the intended fresh-budget resume review was lost). The fixer's resume run therefore uses a distinct concurrency sub-group (`dev-loop-pr-<N>-resume`) so the two resume runs never contend with each other; a resume reviewer can still pend behind another shared-group occupant and be displaced by any later entrant. Issue-side resume is re-adding `dev-loop` (the `issues: [labeled]` implementer row above)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `issues: [closed]`                                                                                                | cost report                                            | gated on the `dev-loop` label and `state_reason == completed` (job-level `if` on the event payload; `not_planned`/`duplicate` closes skip before a runner is allocated). Sums the stream artifacts of every dev-loop run that served the issue and posts/edits the marker-deduped report comment (see below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `workflow_dispatch`                                                                                               | manual backstop                                        | re-tick on missed events; also the `/dev-loop status` equivalent; the cost-report backstop takes an issue number and re-checks the live close reason, so a retry can never post for a not-planned/duplicate close                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Job-level event filters (all three role workflows): every role job carries an `if:` that
skips events which can never start that role _before a runner is allocated_ — `labeled` for
any label other than `dev-loop`, `unlabeled` for any label other than `needs-human`, and on
the fixer an empty-body `pull_request_review` (reply-only submission — the human findings
channel requires a body; the gate would skip it anyway — the fixer has no `synchronize`
trigger at all, per the event map's conflict-origin-1 row). This keeps the loop's own state transitions (escalations adding/removing `needs-human`)
from spawning gated no-op runs; the in-job gate remains as defense in depth and still enforces
label/draft/fork/SHA rules against the live API state. On issues, `needs-human` is informational
only: the implementer's escalation removes `dev-loop` (parking) and re-adding `dev-loop` resumes
— there is no `unlabeled` trigger and no `needs-human` gate on the issue path.

Human input channels (the owner acts under the same PAT login as the loop, so channels are
partitioned by review shape, not identity alone):

- **Findings**: an owner-authored `COMMENT` review with a non-empty body dispatches the fixer,
  which treats the body and inline comments like review findings - fixing what is actionable,
  replying to every comment, pushing only real changes. One deliberate review = one dispatch.
  The body text is mandatory: the job-level `if` pre-filters every empty-body review event
  before a runner is allocated, so a comment-only owner submission (fresh inline threads,
  no review body - not replies) is ignored exactly like a reply-only one; put at least a
  summary sentence in the review body so the channel fires. A findings review submitted while
  the PR is a draft is never dispatched (the fixer gate skips drafts on every event) and has
  no consumption path - marking the PR ready fires only a fresh reviewer run, whose newer
  review supersedes the draft-time one on every resume path - so re-submit it once the PR is
  ready. If the head moves past a human findings review before it is consumed (another
  review's fix in flight, or a manual push), the fixer never drops it silently: it posts a
  PR comment marking the review stale (re-submit on the current head if the findings
  persist) and chains the reviewer on the moved head - a dedupe-bounded backstop (the fix
  push's own `synchronize` event usually re-reviews the moved head first, and the fresh
  review re-surfaces the findings only if it independently finds them; escalation if the
  chain fails). Only the human-findings shape gets that treatment, re-checked at the stale
  branches themselves (mirroring the event gate and the resume jq): a manually dispatched
  review id of any other shape - an empty-body reply review, or an `APPROVED` /
  `CHANGES_REQUESTED` body review - plain-skips like a marker review, posting no notice
  and chaining nothing, because such shapes carry no findings the loop could consume.
  The review id stays consumable on every path: the fixer's verdict re-check is shape-based
  (only marker reviews are held to `Verdict: CHANGES_NEEDED`), so the post-step's built-in
  auto-retry and a manual `workflow_dispatch` re-dispatch of a human findings review work.
  The retry's stale-review skip is attribution-aware for human (non-marker) reviews:
  the auto-retry carries the first attempt's head-before/after observation plus push
  evidence from its own event stream (`moved_by_fix`), so a head moved by that attempt's
  own successful `git push` skips with a PR notice that the review was consumed by that
  attempt (which ended unparseable, so its fix may be partial; the re-review of the moved
  head re-surfaces findings only if it independently finds them - re-submit if findings
  persist; `synchronize` re-reviews the moved head), while a head that moved without a
  push of the attempt's
  own - a manual push by the owner (the per-PR concurrency slot excludes only other
  loop runs) or a fixer run for another review that ran after the attempt released the
  slot - gets the stale-review notice and reviewer chain - the unattributed human case
  is never a silent skip. A marker review on a retry plain-skips on any non-auto-format
  head movement, attributed or not: its findings are machine-derived, and the mover's
  own `synchronize` re-review of the moved head re-derives them, so no human input can
  be stranded by that skip.
- **Answers while parked** (`needs-human`): inline replies to review comments and answers under
  the `<!-- dev-loop-escalation -->` comment are NOT triggers (empty-body replies are
  pre-filtered); they are consumed by the resume path - removing `needs-human` re-fixes the
  newest owner findings review: the newest owner review with a body, kept only when its shape
  is consumable (a marker review needs `Verdict: CHANGES_NEEDED`; a human findings review must
  be non-marker `COMMENTED`). A newer non-CHANGES_NEEDED marker verdict stands on its own and
  suppresses an older human findings review (the reviewer workflow's unlabeled resume path
  re-reviews with a fresh budget instead), so a fixer run that escalated on a human review -
  WALL, watchdog, deadline or a pre-agent failure - resumes into that same review only while
  it stays the newest owner review with a body, instead of dead-ending on a stale marker review
  or a silent no-op. The fixer prompt reads the review-comment threads (`pulls/<N>/comments`,
  which includes `in_reply_to_id` threaded replies that neither the review-scoped endpoints
  nor `gh pr view --comments` show) and the escalation conversation, where the owner's
  answers override the review.
- **Steering an active cycle**: park first (`needs-human`), write the answers, then resume -
  this serializes human input instead of racing the cycle.
- **Merge decision**: the loop never merges; the human merge click is the final act.

Non-events by design:

- `pull_request: [converted_to_draft]` is **never a trigger** — a draft PR is simply never
  reviewed; no dispatch is needed to express that.
- The **fixer has no `synchronize` trigger**: a fix push spawns only the reviewer, so the
  two roles never race for the shared concurrency slot (PR #106 stall); conflict origin 1
  is covered by the reviewer's red-dispatch instead.
- `pull_request: [synchronize]` on **draft** PRs is a non-event (no review of intermediate
  draft states; the loop resumes when a human flips the PR ready, which fires
  `ready_for_review`).
- Direct workflow chaining is the deliberate exception, not the rule: the fixer's push
  fires `synchronize`, which re-triggers the reviewer. The cross-role chained dispatches
  are reviewer→fixer (a `CHANGES_NEEDED` verdict with the posted review's id; the red-CI
  no-findings dispatch) and fixer→reviewer (a no-op `FIXED` on an unchanged head; a human
  findings review made stale by an unattributed head move — another review's fix or a manual
  push — so its findings were never consumed by a fixer run for it); the same-role
  re-dispatches — the reviewer's stale-head re-review, the one-shot unparseable-outcome
  auto-retry of both role post-steps, the fixer's push-to-main conflict-scan fanout — are
  enumerated where they occur (post-step state machine, Failure handling, event map).

## Post-step state machine (all post-steps, no agent involvement)

| Post-step   | Condition                                                                       | Action                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| reviewer    | `Verdict: CHANGES_NEEDED`                                                       | dispatch the fixer with the posted review's id (a direct chain: no GitHub event carries the review id; one of the chained dispatches enumerated in Non-events by design) |
| reviewer    | `Verdict: NEEDS_HUMAN`                                                          | label `needs-human` + marker escalation comment `@$REPO_OWNER` (the `github.repository_owner`-derived mention every escalation template uses)                            |
| reviewer    | head SHA moved since review start                                               | re-dispatch reviewer (stale review is not acted on)                                                                                                                      |
| fixer       | outcome `FIXED` (findings fixed and/or conflicts resolved, merge commit pushed) | nothing — the push fires `synchronize`, which triggers the reviewer                                                                                                      |
| fixer       | outcome `WALL:`/budget stop                                                     | label `needs-human` + escalation comment                                                                                                                                 |
| implementer | outcome `finished`                                                              | open a **ready** PR (`Closes #<N>`) with the `dev-loop` label; `ready_for_review` fires the first review                                                                 |
| implementer | outcome `NO_PR`                                                                 | comment questions on the issue + label `needs-human`                                                                                                                     |

The reviewer is never called twice for the same work: dispatches on the same PR serialize in
the shared `dev-loop-pr-<N>` concurrency group, the head-SHA marker dedupe makes at most one
review per commit, and a push landing mid-review is handled by the stale-head re-dispatch (the
older verdict is never acted on). If the fixer and a conflict-only fixer run both push, those
are distinct head SHAs — each legitimately gets its own review.

## The fixer absorbs the merger

There is no separate merger role. The fixer's scope grows by merge-conflict resolution:

- The fixer prompt checks `mergeable` first; a `CONFLICTING` PR is no longer an abort
  (`CONFLICTING` outcome removed) — the fixer merges `origin/main` into the PR branch with a
  merge commit, resolving both sides minimally, then proceeds to the findings (conflicts first:
  `npm run build`/`npm test` cannot run meaningfully on a conflicted tree).
- The conflict triggers dispatch the **same** fixer workflow with a conflict-only task: no
  open `CHANGES_NEEDED` review, only the conflict — both dispatch origins pass
  `review_id=none`, a sentinel the fixer gate resolves as an explicit no-findings run (an
  empty review id would fall into the gate's resume resolution and pull an outstanding
  `CHANGES_NEEDED` review's findings in). Origin 1 is the reviewer's red-dispatch
  (the PR's own push made it conflicting; the conflicted head's checks are red); origin 2
  is a `push` to `main`, whose gate scans open dev-loop PRs and dispatches one
  conflict-only run per conflicting PR (a mergeability of `UNKNOWN` right after the push
  is re-listed boundedly; PRs still `UNKNOWN` are dispatched anyway — the dispatched run
  re-checks `CONFLICTING` live and skips non-conflicting PRs).
- `review_id` dispatches resolve the fixer workflow at `--ref main`, so sentinel sender
  (reviewer red-CI dispatch, fixer no-findings retry, push scan) and receiving gate must be
  the same protocol generation. Until they merge together, a dispatch can still resolve
  `main`'s previous gate, which treats `none` as a literal review id and fails with an
  HTTP 404 (observed on PR #116's own pre-merge window). The window closes when both
  workflow files merge atomically; the gate also degrades any non-numeric review id to a
  no-findings run, so an unrecognized sentinel skips green instead of red.
- Conflict-dispatch dedupe: one fixer run per head SHA — the dispatched conflict-only run
  re-checks `CONFLICTING` live and skips if the head has already moved (another fixer
  resolved it); the next push (or a manual `workflow_dispatch`) moves the head and re-offers.
- Prompt rules carried over from the old merger role verbatim: "never rebase, merge commits
  only"; unresolvable conflicts end with `WALL: <reason>`.

Outcome contract (fixer): `FIXED: <summary>` or `WALL: <reason>` — nothing else. The post-step
verifies the claim against reality (head SHA moved) before relying on it.

## Loop bounding

- **Iteration cap in code**: the reviewer workflow's pre-step counts marker-prefixed reviews
  since the last escalation comment (per escalation epoch). At `MAX_ITERATIONS` (8), it
  deterministically labels `needs-human`, posts the escalation, dispatches nothing. Agents
  cannot see or negotiate the cap.
- **Per-run budgets**: step cap / token cap on every role run, enforced by the stream
  watchdog (plus the job `timeout-minutes` and `timeout(1)` as the wall-clock caps); a budget
  stop escalates instead of chaining.
- **Fixer completes only on `FIXED`**: `WALL:` or a limit-stop breaks the cycle; a successful
  fix re-enters the loop purely via its own `synchronize` event.
- **One review per head SHA**: pre-step skips if a marker review with `commit_id == headRefOid`
  exists; a push landing mid-review re-dispatches after the stale review completes.
- **One fixer run per head SHA** (conflict path): the dispatched run re-checks `CONFLICTING`
  live and skips if the conflict is already resolved; the head-SHA-stale checks bound it.

## Guardrails (replacing `guard-bash.mjs`)

- **Push safety**: branch protection on `main` (no direct pushes, no force-push, PRs only).
- **Per-role tokens**: fine-grained PAT, this repo only, `contents:write` +
  `pull-requests:write` for implementer/fixer; the reviewer job posts its review from the
  workflow step (not the agent), so its agent run can use a read-only environment.
- **PAT rule (critical)**: all dev-loop posts (reviews, comments, pushes, label changes) use
  the PAT, **never** `GITHUB_TOKEN` — events created by `GITHUB_TOKEN` do not trigger further
  workflows (GitHub recursion guard); the PAT keeps the chain alive.
- **Own-repo PRs only**: compare `pull_request.head.repo.id` against `repository.id` (same
  repository-ID space; an owner ID never matches — see PR #93); never `pull_request_target`.
  Fork PRs are skipped, as in PR #80. The `push: main` conflict scan resolves candidate PRs
  via `gh pr list`, whose `headRepository.id` is a GraphQL node id — the scan therefore
  compares it against `repository.node_id`, not the numeric REST id (each check stays in
  its own ID space: REST ids in the event payload, GraphQL node ids in gh's JSON). For
  the dispatched runs the scan's same-repo candidate filter **is** the fork gate: they
  arrive as `workflow_dispatch` events, whose payload carries no PR, so the fixer gate's
  own fork check (guarded to skip on an empty `pull_request.head.repo.id`) never fires
  there — only on `pull_request`/`pull_request_review` events.
- **Three reviewer gates, in order**: `dev-loop` label present → not draft → no `needs-human`
  label. A PR failing any gate is never reviewed. Draft is a human parking brake; the loop
  never flips it either way.
- **Opt-in scope**: no workflow touches an issue or PR without the `dev-loop` label (see above).
- **Kept as prompt rules**: "never rebase, merge commits only" (fixer, incl. conflict
  resolution), "fix findings minimally" (fixer), "review adversarially, report every nit"
  (reviewer). Agents are prompt-forbidden from `gh pr ready`/`gh pr merge`/label changes
  entirely — with no draft/ready state machine there is simply nothing for an agent to flip.
- **Verdict semantics (reviewer)**: `CLEAN` requires zero findings of severity `blocker`,
  `major` or `minor`; new `nit` findings do not block the verdict — they are reported as
  informational feedback (the fixer is never dispatched on `CLEAN`), while anything at
  `minor` or above still means `CHANGES_NEEDED`. This is the loop's convergence mechanism:
  an adversarial full-diff re-review by a fresh reviewer instance would otherwise almost
  always find one new nit on a non-trivial PR and re-enter the fix cycle on a converged
  head (observed on PRs #115 and #117: eight strictly-converging rounds each hit the
  iteration cap because the zero-nit `CLEAN` bar made the goalposts move every round).
- **Continuity across review rounds (reviewer)**: each round reads the prior marker reviews
  and the fixer's inline replies (`pulls/<N>/comments`, threaded by `in_reply_to_id`). A
  fixed finding is verified and dropped; a finding the fixer declined with a rationale is
  accepted unless factually wrong. Re-raising a settled nit with no new argument is the
  non-convergence failure mode the iteration cap would otherwise have to break
  mechanically.

## CI (`ci.yml`)

Stays a pure gate: format-auto-fix, lint, typecheck, tests — unchanged. Additions:

- **Mergeability probe** (optional, informational): report `mergeable` state in the run
  summary; not a required check, never fails the build. The fixer's conflict dispatch reads
  PR state directly anyway.
- Conflict resolution runs in the **fixer workflow** (`synchronize` / `push: main` triggers),
  not inside CI: CI stays fast, deterministic and trusted; the agentic, budgeted,
  escalation-capable run would otherwise make "the build is red" mean two different things.
- **Review-post hardening**: before posting, the post-step deletes a stale pending review of
  the token user **only if it carries zero draft comments AND an empty body, or its body's
  first line is the `<!-- dev-loop-review -->` marker**
  (one-pending-review-per-user-per-PR is an API limit; a leftover from a failed post
  422-blocks every future POST - the PR #106 wedge - and a marker-prefixed leftover, being
  provably not a human draft (the marker is invisible in the GitHub UI and the human channel
  is non-marker by definition), self-heals too; a pending review WITH draft comments or a
  non-marker body may be the owner's findings review being drafted in the GitHub UI - the
  token user is the owner, and the body is the primary human findings payload - and is never
  deleted), validates the payload file is valid JSON, surfaces gh's full error object in the
  log instead of discarding it, and never dispatches the fixer with a non-numeric review id.
- **Red CI heads skip the review**: the reviewer's CI gate dispatches the fixer directly
  (`review_id=none` sentinel = no-findings run: conflicts and/or failing CI checks; the fixer
  prompt fetches the failing check logs). An auto-format push never reaches the fixer this way —
  the formatter's own push moves the tip, so the waiting reviewer skips and the new head's
  `synchronize` starts a fresh cycle; the formatted head's CI is green by construction.

## Cost report on issue close

When a dev-loop issue is closed as completed, the cost-report workflow
(`.github/workflows/dev-loop-cost-report.yml`) posts the total AI token usage and cost
accumulated by every dev-loop agent run that served it — implementer, reviewer and fixer
alike. Closes with `state_reason` `not_planned` (won't do) or `duplicate` and unlabeled
issues never get a report: the job-level `if` checks the event payload before a runner is
allocated, and the gate re-checks the live issue state, so the `workflow_dispatch` backstop
(a manual retry) can never post for a not-planned/duplicate close either.

- **Run-to-issue association**: the three role workflows record their target in the artifact
  name — `opencode-implementer-output-issue-<N>-<run_id>-<run_attempt>` for the implementer,
  `opencode-(reviewer|fixer)-output-pr-<M>-…` for the PR roles — the only artifact metadata
  that can be filtered without a download (run metadata carries neither the issue nor the
  dispatch inputs). The report resolves the issue's PRs two ways — cross-referenced PRs whose
  live body still carries a closing keyword reference (`Closes|Fixes|Resolves #<N>` or the
  issue-URL form; a
  cross-reference event fires for any mention, so the mention alone must not attribute costs;
  cross-references from other repositories are ignored — their local PR numbers mean
  something different here — and so are negated references like "does not close #<N>")
  plus the `vibe/issue-<N>-*` branch convention — then matches artifact names. The
  association assumes the loop's one-PR-per-issue convention: a PR that closes (or
  branch-matches) two dev-loop issues contributes its full reviewer/fixer run costs to
  each issue's report, so shared costs are double-counted across the issues (splitting
  them is not implemented). Runs whose
  artifacts predate the naming scheme are not attributable; the report then finds nothing and
  posts no comment, so the first reported issue is the first one fully served after the scheme.
- **Aggregation**: per run, cost is the sum of `part.cost` and tokens the cost-weighted sum
  (input + output + cache.write + 0.1 × cache.read, the cap semantics) over the
  `step_finish` events in the run's `stream.ndjson` artifact — the same jq the role
  post-steps use, per-run cost rounded to cents; the comment breaks the totals down per
  role and links every run.
- **Retention**: artifacts expire with the default retention (90 days); an issue closed
  after some of its artifacts expired reports over what remains and notes the unavailable
  count (the totals undercount those runs); if every matched artifact is unavailable, the
  report posts a no-data comment carrying that count instead of totals (a successful
  backstop re-run replaces it via the marker dedupe). A reviewer/fixer run still in flight
  when the issue closes uploads its artifact after the close-event report has run, so that
  run is missing from the totals until someone re-runs the `workflow_dispatch` backstop (the
  marker-deduped edit then folds the late run in).
- **Idempotency**: the report comment is marker-deduped
  (`<!-- dev-loop-cost-report -->`); a re-run edits the existing comment instead of
  double-posting.
- **Authentication**: the comment is posted with `DEV_LOOP_TOKEN` (PAT rule); artifact
  listing/download uses the job token with `actions: read`, so the fine-grained PAT needs no
  scope change.

## New files

```
.github/workflows/dev-loop-implement.yml   issue -> ready PR (dev-loop labeled, Closes #<N>)
.github/workflows/dev-loop-review.yml      ready PR -> one marker review -> state post-step
.github/workflows/dev-loop-fix.yml         CHANGES_NEEDED review or CONFLICTING CI run
                                           -> fix commits / merge-commit conflict resolution
.github/workflows/dev-loop-cost-report.yml closed-as-completed dev-loop issue -> cost report comment
.github/dev-loop/prompts/implementer.md    role prompts (ported from PR #80's agent definitions,
.github/dev-loop/prompts/reviewer.md       minus gh-guard boilerplate; final line is a parseable
.github/dev-loop/prompts/fixer.md          outcome: PR_URL|NO_PR:, VERDICT:, FIXED:|WALL:)
docs/dev-loop.md                           this plan / runbook
```

Role job skeleton (shared):

```yaml
permissions:
  contents: write
  pull-requests: write
concurrency:
  group: dev-loop-pr-${{ inputs.pr }}   # or issue-<N>; fixer exception: unlabeled-resume
                                        # runs use the -resume sub-group (see event map)
  cancel-in-progress: false
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4         # node 22, npm cache (mirrors ci.yml)
  - run: npm ci
  - run: curl -fsSL https://opencode.ai/install | bash
  - run: render .github/dev-loop/prompts/<role>.md with the budget values, then:
        timeout --signal=TERM --kill-after=60 <time-limit> \
          opencode run --standalone --format json --auto --model mistral/zai-glm-5-3 \
          "$(cat out/<role>.rendered.md)" \
          2> out/opencode.stderr | tee out/stream.ndjson | <watchdog>
        env:
          MISTRAL_API_KEY: ${{ secrets.MISTRAL_API_KEY }}
          GH_TOKEN: ${{ secrets.DEV_LOOP_TOKEN }}
          DEV_LOOP_ARGS: <pr/issue number, branch, review id>
          OPENCODE_CONFIG_DIR: <job-local dir>   # env var must be the only credential source
          OPENCODE_DISABLE_AUTOUPDATE: 'true'
          NO_PROXY: 127.0.0.1,localhost         # managed service binds a loopback port
            (verified against opencode v2.0.26: `run` is the non-interactive mode,
            `--standalone` avoids the shared managed-service port state on the runner,
            `--format json` emits the live JSON event stream the watchdog and the
            post-step consume — event types step_start / step_finish / text /
            tool_use, with per-step `cost` and `tokens` (incl. cache read/write) on
            step_finish, so no export file is needed for outcome/cost. The installed
            opencode version must be pinned and verified: the CLI surface moved
            substantially between majors (v1.19 vs v2.0 — auth flags, provider
            config env vars, service architecture))
  - uses: actions/upload-artifact@v4     # out/export.json + out/stream.ndjson + stderr:
                                         # outcome, stop reason, cost, final message
  - run: <post-step: state machine per table above, using the PAT>
```

The reviewer posts its review **from the post-step** (reads the agent's verdict out of
`out/stream.ndjson` — the last assistant message — plus `out/export.json` for outcome and
cost, composes the marker-prefixed JSON, `gh api` posts it), so the agent never needs
review-writing API access.

## Secrets & settings

- `MISTRAL_API_KEY` — Actions secret (masked in logs on public repo).
- `DEV_LOOP_TOKEN` — fine-grained PAT, this repo only, `contents:write` + `pull-requests:write`
  (+ `issues:write` for the implementer's issue comments).
- `needs-human` label as in PR #80; `dev-loop` label as the opt-in gate.
- Public repo: hosted runners free and unlimited. Optional later: self-hosted runner on the
  Synology (zero minutes cost, key stays on LAN).

## Budgets and parameters

Calibrate from the `out/stream.ndjson` artifacts after the first real runs; these are the starting caps
(steps/tokens enforced by the stream watchdog — a cap hit kills `opencode run` and the
post-step classifies rc 99; time enforced by `timeout(1)`, rc 124 — not a hang):

| Role                              | steps (watchdog) | tokens (watchdog, cost-weighted) | time limit (`timeout(1)`) | job `timeout-minutes` | Rationale                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ---------------- | -------------------------------- | ------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| implementer                       | 800              | 6M                               | 5400                      | 105                   | the heaviest role: reads issue + AGENTS.md, full src, writes code + tests, runs build/test/lint. First live run used 71 steps / 3.03M tokens / $4.63 on a modest issue; with opencode prompt caching observed at 93-99% hit rate, steps are cheap (~10% input cost), so the step cap is a generous runaway guard (~7x the vibe-era 120-turn budget) and the 90-min deadline is the real constraint |
| reviewer                          | 400              | 4M                               | 3600                      | 75                    | read-only but adversarial: reads diff + linked issue + prior reviews, runs build/test/lint once; calibrate from its first artifacts                                                                                                                                                                                                                                                                |
| fixer (incl. conflict resolution) | 400              | 4M                               | 3600                      | 75                    | scoped to one review's findings and/or one conflict; usually well under. Conflict resolution is bounded work; a conflict-heavy run that cannot finish stops with `WALL:` like anything else                                                                                                                                                                                                        |

The token cap is cost-weighted: input + output + cache.write + 0.1 × cache.read —
cached tokens count at their 10% billing rate, so the cap means "N uncached-equivalent
tokens" and preserves the vibe-era cost semantics: a heavily cached, cheap, healthy run
cannot blow it. The post-step reports the same sum, so artifacts calibrate against what
the cap enforced. Token spend remains the direct measure of work; a token-cap
hit is a truthful "this run consumed excessive tokens". A step-cap hit means the agent
looped: the cap is deliberately far above any honest run. Hard ceiling independent of
opencode: the GitHub job timeout (`timeout-minutes`) set 15 min above each time limit, so a
wedged process cannot burn the 6-hour job limit. A time-limit hit is rc 124 with a complete
event-stream transcript up to the kill. Expected real-world spend per happy-path PR
(implement + 1–2 reviews + 1 fix + occasional conflict resolution): with caching, a fraction
of the $5–15 uncached estimate; dry-run sessions measured ~$1.29 for 5.9M tokens.

**Budget awareness in the prompt**: each role prompt is rendered with its caps (the workflow
pre-step injects `MAX_TURNS`, `TIME_LIMIT_MIN` (the job's wall-clock budget) into the prompt file via a template
step, so the numbers live in one place — the workflow — not in the prompt text). The prompt
tells the agent its turn budget and instructs it to plan accordingly: front-load reading the
issue/PR and `AGENTS.md`, implement, then reserve the last ~20% of the budget for running
`npm run build`/`npm test`/`npm run lint` and fixing what they surface. If the agent believes
it cannot finish within the budget, it must stop early with `WALL: <reason>` rather than
run until the harness kills it — a deliberate stop yields a useful escalation, a budget hit
does not. Caveat: agents cannot observe their live usage, so this is planning guidance, not
a hard guarantee; the harness cap remains the enforcement and the two complement each other.

## Failure handling

Principle: a failed role run never chains, never retries itself, and always leaves a visible
GitHub trace. No silent stuck states. "Never retries itself" is scoped to the deterministic
failure codes below (rc 1, rc 99, rc 124 — never auto-retried); the one exception is the
unparseable-outcome row: exit 0 without a contract line is presumed a truncated, transient
run, so the post-step auto-retries it once via `workflow_dispatch` before escalating. Every
failure path ends in exactly one of:
(a) a `needs-human` label + marker escalation comment (`@$REPO_OWNER`, reason, pointers),
(b) a benign no-op, or (c) an Actions-visible failed run that the dispatch backstop can re-tick.

The opencode exit code and the event stream (`out/stream.ndjson` + `out/opencode.stderr`)
are the discriminators. Opencode v2.0.26 exit codes (measured): 0 finished, 1 config or
infrastructure failure **or a session that recorded (recovered) tool errors** — v2.0.26
exits 1 whenever any tool call errored, even when the agent recovered and completed its
work with a valid contract line (observed on the #98/#99 loop: failed `websearch`/`webfetch`
calls, no search-provider key configured, flip an otherwise successful run to rc 1; the
role jobs now pass `TAVILY_API_KEY` and pin `"websearch": {"provider": "tavily"}` in the
job-local `opencode.jsonc` when the secret is set, so websearch/webfetch work headless). The
post-steps therefore treat rc 1 as finished **iff** the final message parses the role's
outcome contract (`PR_URL:`/`NO_PR:`/`WALL:`, `VERDICT:`, `FIXED:`/`WALL:`), and escalate
only when it does not. Remaining exit codes: 124 deadline (`timeout(1)`), 130 killed by
signal, 99 watchdog kill (convention of this workflow, not opencode's):

| What failed                                                              | Detection                                                                                                                                            | Handling (post-step, in code)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| model API outage / runner infra                                          | exit 1 with a connection-error signature in stderr                                                                                                   | escalate with reason + run link; manual retry stays available via the `workflow_dispatch` retry input (never auto-retry: rc 1 cannot distinguish transient from deterministic)                                                                                                                                                                                                                                                                                                                                                                             |
| budget hit (steps/tokens)                                                | watchdog kills opencode after the cap, rc 99                                                                                                         | escalate: label `needs-human`, comment the caps + cost summed from `step_finish` events, link the artifact. Never auto-retry: a budget hit means the task, not the run, is the problem. Step cap = agent looped; token cap = run consumed excessive tokens                                                                                                                                                                                                                                                                                                 |
| deadline                                                                 | rc 124 from `timeout(1)`                                                                                                                             | escalate with cost from the stream; never auto-retry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| wall-clock timeout (belt above the time limit)                           | job killed by `timeout-minutes` (no opencode exit code)                                                                                              | red run; the re-run backstop covers it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| usage/config error (bad flag, missing API key)                           | exit 1 (`Error: ...` in stderr)                                                                                                                      | escalate; deterministic, a retry fails the same way                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| tool-failure loop (agent retries failing commands)                       | watchdog kills opencode after N consecutive failed tool calls (`state.status == "failed"`, or non-zero shell exit in `state.metadata.metadata.exit`) | escalate: the agent could not use its tools; a full budget spent on failing calls is pure waste (this happened on the first live run)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| agent finished but outcome unparseable                                   | exit 0, final `text` event doesn't match the contract                                                                                                | one-shot auto-retry via `workflow_dispatch` (retry=1; the fixer's retry also passes `moved_by_fix`, the first attempt's head-before/after observation plus push evidence from its event stream, so the retry's stale-review skip stays attribution-aware for human reviews - a marker review plain-skips on any moved head, and the mover's `synchronize` re-review re-derives its findings); on the retried run escalate with reason "unparseable outcome (retry exhausted)" + link to the transcript artifact; the transcript is preserved for diagnosis |
| agent reported `WALL:` / `NO_PR:`                                        | exit 0, parseable                                                                                                                                    | the designed escalation: implementer comments its questions on the issue + labels it; fixer escalates on the PR                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| workflow step failed _outside_ opencode (npm ci, install, push rejected) | step exit code                                                                                                                                       | normal Actions red run: visible on the run, GitHub can "re-run failed jobs"; if the same step fails twice (run attempt > 1), escalate instead of leaving it red silently                                                                                                                                                                                                                                                                                                                                                                                   |

Per-role specifics:

- **implementer fails** → nothing exists yet on GitHub except the issue. Post-step comments on
  the issue ("dev-loop implementer failed: <reason>, run: <link>") and labels it `needs-human`.
  The issue is never lost; re-adding the `dev-loop` label re-triggers the implementer with a
  fresh budget (the escalation removed it to park the issue).
- **reviewer fails** → the PR sits ready-for-review with no review. Post-step comments
  on the PR with the failure reason. Human can re-run the job or push a trivial change to
  re-trigger `synchronize`. A ready PR without a review stays unmergeable by review policy,
  so nothing unsafe happens.
- **fixer fails** → the review's findings still stand; the PR simply doesn't progress. Post-step
  comments on the PR; the human can remove `needs-human` to re-trigger the fixer on the same review.
- **fixer fails on the conflict path** → the PR stays `CONFLICTING`; the next push (the fixer's
  own retry via `workflow_dispatch`) or the next merge to `main` re-offers the conflict
  dispatch (natural retry, bounded by the one-run-per-head-SHA gate). Escalation only after
  repeated failure (track via a `dev-loop-retries` label or comment count).

Backstop: `workflow_dispatch` on each role workflow doubles as the manual retry button, and a
`workflow_dispatch` "tick" re-derives state from GitHub and re-dispatches anything stuck —
which is also the recovery path if a webhook event was ever missed.

## Implementation phases

1. ~~**Phase 1 — implementer only**~~ (done, PRs #82–#90): `dev-loop-implement.yml` +
   `implementer.md` prompt, validated live (issue #60 → PR #91, CI green, sane cost).
2. ~~**Phase 2 — reviewer + fixer**~~ (done, PRs #85, #86, #93): `dev-loop-review.yml` +
   `dev-loop-fix.yml` + fixer chain + iteration cap; full CHANGES_NEEDED → fixer → reviewer
   cycle validated live on PR #91.
3. **Phase 3 — event-driven refactor + conflict resolution in the fixer**: remove the
   draft/ready state machine (implementer opens ready PRs; reviewer/fixer never flip draft
   state; drop all reviewer re-dispatch chains except the CHANGES_NEEDED→fixer dispatch),
   extend the fixer to resolve merge conflicts (absorb the merger role; `synchronize` and
   `push: main` `CONFLICTING` entries on `dev-loop-fix.yml` with one-run-per-head-SHA
   dedupe), and switch
   all gates to the opt-in `dev-loop` label. Soak test for a week.
4. **Phase 4**: budget calibration from accumulated transcript artifacts, reviewer prompt
   iteration, retry/failure-path drills (simulate API outage, budget cap, unparseable outcome).
5. **Cleanup**: close PR #80 as superseded.

## Acceptance criteria

- A `dev-loop`-labeled open issue becomes a ready PR without human interaction; CI passes.
- No workflow touches an issue or PR without the `dev-loop` label.
- Review runs exactly once per head SHA; pushes to draft PRs never trigger it; a `needs-human`
  label parks the item; drafts are the human parking brake and the loop never flips them.
- A push to a ready PR (fix commits or CI auto-format) triggers re-review via `synchronize`;
  a role chains the reviewer directly only in the backstop cases enumerated in Non-events by
  design.
- `CHANGES_NEEDED` triggers the fixer exactly once; the fixer's push re-enters the loop via
  its own event; the cycle escalates at 8 iterations, in code.
- A conflicted PR gets a merge commit resolving both sides from the fixer workflow (findings
  or the synchronize/push conflict-only path), and the push is re-reviewed.
- On PRs, `needs-human` parks the item; removing it resumes it with a fresh budget. On issues,
  `needs-human` is informational only: the implementer's escalation parks the issue by removing
  `dev-loop`, and re-adding `dev-loop` resumes it with a fresh budget.
- Every role run is bounded by the step/token caps and the job timeout; the transcript
  artifact preserves what happened within those bounds.
