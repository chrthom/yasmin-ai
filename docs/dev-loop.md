# Dev Loop on GitHub Actions + Mistral Vibe — Implementation Plan

Successor design to PR #80 (`.openclaude/` skill/agents/guard): GitHub Actions replaces the
orchestrator (no cron tick, no `state.json`, no command-text guard); the agentic work
(implement / review / fix / merge-conflicts) stays with a real coding-agent harness —
Mistral Vibe — executed headless on the workflow runner, with its full local toolset
(edit files, `npm run build`, `npm test`, `npm run lint`, `npx prettier`).

GitHub is the source of truth (issues, PRs, reviews, labels). The loop is fully event-driven:
every dispatch follows a GitHub event or a direct chain from a preceding role's post-step.

## Architecture

```
GitHub event (or previous post-step)
        │
        ▼
role workflow (reviewer / fixer / merger / implementer)
  pre-step: gate + dedupe (head SHA, verdict, iteration cap)
  job:      checkout → Node 22 → npm ci → render prompt (budget injected) →
            vibe -p --trust --output json --max-price --max-turns
            --enabled-tools <role> < out/<role>.rendered.md > out/messages.json
  post-step: deterministic state machine from out/messages.json
             (ready/draft, labels, escalation, next dispatch)
```

Agents never change PR state (draft/ready/labels) themselves: every state transition is a
workflow post-step, auditable in the run log, enforceable in code.

## Event map (final, agreed)

| Trigger | Fires | Guard / notes |
| --- | --- | --- |
| `issues: [opened, reopened]` | implementer | skip if `needs-human` or a `vibe/issue-<N>-*` branch exists |
| `pull_request: [ready_for_review]` | reviewer | primary review trigger; marker-dedupe on head SHA |
| `pull_request: [synchronize]` | reviewer | **only if PR is not draft** (push to a ready PR invalidates its CLEAN verdict); drafts stay push-silent |
| `pull_request_review: [submitted]` | fixer | event payload gate: marker line + `Verdict: CHANGES_NEEDED`; `CLEAN` and human reviews start nothing |
| fixer post-step, outcome `finished` | reviewer | **direct workflow chain** (no GitHub event; recursion guard irrelevant) |
| `workflow_run` (`ci.yml` completed) + `mergeable == CONFLICTING` | merger | covers both conflict origins: PR diverges, or `main` moved under it |
| `issues/pull_request: [unlabeled]` on `needs-human` | resume | reviewer or fixer, per PR state; resets the iteration budget |
| `workflow_dispatch` | manual backstop | re-tick on missed events; also the `/dev-loop status` equivalent |

Non-events by design:

- `pull_request: [converted_to_draft]` is **never a trigger** — it is ambiguous (reviewer
  post-step and merger post-step both use it) and would double-dispatch.
- `pull_request: [synchronize]` on **draft** PRs is a non-event (no review of intermediate
  draft states; re-review happens only at ready-for-review or via the fixer chain).

## Draft/ready state machine (all post-steps, no agent involvement)

| Post-step | Condition | Action |
| --- | --- | --- |
| reviewer | `Verdict: CLEAN` | `gh pr ready` |
| reviewer | `Verdict: CHANGES_NEEDED` | ensure draft (usually already draft → no event) |
| reviewer | `Verdict: NEEDS_HUMAN` | label `needs-human` + marker escalation comment `@chrthom` |
| reviewer | head SHA moved since review start | re-dispatch reviewer (stale review is not acted on) |
| fixer | outcome `finished` | chain reviewer workflow directly |
| fixer | outcome `WALL:`/budget stop | label `needs-human` + escalation comment |
| merger | merge commit pushed | `gh pr ready --undo` (conflict resolution is a code change → re-review) |
| merger | outcome `WALL:` | label `needs-human` + escalation comment |
| implementer | outcome `finished` | open draft PR (`Closes #<N>`); PR stays draft |
| implementer | outcome `NO_PR` | comment questions on the issue + label `needs-human` |

The reviewer's `gh pr ready` fires `ready_for_review`, which re-triggers the reviewer
workflow — harmless: the marker-dedupe (same head SHA, existing `CLEAN` review) makes it a
no-op.

## Loop bounding

- **Iteration cap in code**: the reviewer workflow's pre-step counts marker-prefixed reviews
  since the last escalation comment (per escalation epoch). At `MAX_ITERATIONS` (8), it
  deterministically labels `needs-human`, posts the escalation, dispatches nothing. Agents
  cannot see or negotiate the cap.
- **Per-run budgets**: `--max-price` / `--max-turns` on every role run (plus the job
  `timeout-minutes` as the wall-clock cap); a budget stop escalates instead of chaining.
- **Fixer chains only on `finished`**: `WALL:` or a limit-stop breaks the cycle.
- **One review per head SHA**: pre-step skips if a marker review with `commit_id == headRefOid`
  exists; a push landing mid-review re-dispatches after the stale review completes.

## Guardrails (replacing `guard-bash.mjs`)

- **Push safety**: branch protection on `main` (no direct pushes, no force-push, PRs only).
- **Per-role tokens**: fine-grained PAT, this repo only, `contents:write` +
  `pull-requests:write` for implementer/fixer/merger; the reviewer job posts its review from
  the workflow step (not the agent), so its agent run can use a read-only environment.
- **PAT rule (critical)**: all dev-loop posts (reviews, comments, pushes, label changes) use
  the PAT, **never** `GITHUB_TOKEN` — events created by `GITHUB_TOKEN` do not trigger further
  workflows (GitHub recursion guard); the PAT keeps the chain alive.
- **Own-repo PRs only**: `if: github.event.pull_request.head.user.id == github.repository_owner.id`
  on all `pull_request*` triggers; never `pull_request_target`. Fork PRs are skipped, as in PR #80.
- **Draft-only PR creation**: only the reviewer post-step may run `gh pr ready` and only on
  `CLEAN`; agents are prompt-forbidden from `gh pr ready`/`gh pr merge` entirely.
- **Kept as prompt rules**: "never rebase, merge commits only" (merger), "fix findings
  minimally" (fixer), "review adversarially, report every nit" (reviewer).

## CI (`ci.yml`)

Stays a pure gate: format-auto-fix, lint, typecheck, tests — unchanged. Additions:

- **Mergeability probe** (optional, informational): report `mergeable` state in the run
  summary; not a required check, never fails the build. The merger dispatch reads PR state
  directly anyway.
- The merger runs as its **own workflow** (`workflow_run` trigger), not inside CI: CI stays
  fast, deterministic and trusted; the agentic, budgeted, escalation-capable merger would
  otherwise make "the build is red" mean two different things.

## New files

```
.github/workflows/dev-loop-implement.yml   issue -> draft PR
.github/workflows/dev-loop-review.yml      ready PR / fixer chain -> one marker review -> state post-step
.github/workflows/dev-loop-fix.yml        CHANGES_NEEDED review -> fix commits -> chain reviewer
.github/workflows/dev-loop-merge.yml      CI completed + CONFLICTING -> merge commit -> back to draft
.github/dev-loop/prompts/implementer.md   role prompts (ported from PR #80's agent definitions,
.github/dev-loop/prompts/reviewer.md       minus gh-guard boilerplate; final line is a parseable
.github/dev-loop/prompts/fixer.md           outcome: PR_URL|NO_PR:, VERDICT|CONFLICTING,
.github/dev-loop/prompts/merger.md         FIXED|CONFLICTING|WALL:, MERGED|NO_CONFLICT|WALL:)
docs/dev-loop.md                           this plan / runbook
```

Role job skeleton (shared):

```yaml
permissions:
  contents: write
  pull-requests: write
concurrency:
  group: dev-loop-pr-${{ inputs.pr }}   # or issue-<N>
  cancel-in-progress: false
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4         # node 22, npm cache (mirrors ci.yml)
  - run: npm ci
  - run: curl -LsSf https://mistral.ai/vibe/install.sh | bash
  - run: render .github/dev-loop/prompts/<role>.md with the budget values, then:
        vibe -p "$(cat out/<role>.rendered.md)" --trust --output json --max-turns <per role>
        --max-price <per role> --enabled-tools bash --enabled-tools read_file
        --enabled-tools grep --enabled-tools write_file --enabled-tools search_replace
        > out/messages.json
        env:
          MISTRAL_API_KEY: ${{ secrets.MISTRAL_API_KEY }}
          GH_TOKEN: ${{ secrets.DEV_LOOP_TOKEN }}
          DEV_LOOP_ARGS: <pr/issue number, branch, review id>
            (vibe has no --prompt-file: the rendered prompt is passed as the -p argument —
            never via stdin: get_prompt_from_stdin() opens /dev/tty after reading, which
            fails on a tty-less runner and silently discards the prompt; programmatic mode
            auto-approves all tools, --trust skips the trust prompt; --max-turns/--max-price
            apply only in programmatic mode; there is no --time-limit — the job
            timeout-minutes is the only wall-clock cap)
  - uses: actions/upload-artifact@v4     # out/messages.json (full transcript) + vibe stderr:
                                         # final message, stop reason on budget hits
  - run: <post-step: state machine per table above, using the PAT>
```

The reviewer posts its review **from the post-step** (reads the agent's verdict out of
`out/messages.json` — the last assistant message — or the stderr stop tag, composes the
marker-prefixed JSON, `gh api` posts it), so the agent never needs review-writing API access.

## Secrets & settings

- `MISTRAL_API_KEY` — Actions secret (masked in logs on public repo).
- `DEV_LOOP_TOKEN` — fine-grained PAT, this repo only, `contents:write` + `pull-requests:write`
  (+ `issues:write` for the implementer's issue comments).
- `needs-human` label as in PR #80.
- Public repo: hosted runners free and unlimited. Optional later: self-hosted runner on the
  Synology (zero minutes cost, key stays on LAN).

## Budgets and parameters

Calibrate from the `out/messages.json` / stderr artifacts after the first real runs; these are the starting caps
(all enforced by vibe itself — a cap hit stops the session with a parseable
`<vibe_stop_event>` reason on stderr and exit 1, not a hang; the CLI has no exit-2/3 taxonomy,
only 0 and 1, so the stop tag on stderr is the discriminator for budget stops vs other failures;
`--max-tokens` deliberately unset, see table):

| Role | `--max-turns` | `--max-price` | job `timeout-minutes` | Rationale |
| --- | --- | --- | --- | --- |
| implementer | 90 | 7.50 | 105 | the heaviest role: reads issue + AGENTS.md, full src, writes code + tests, runs build/test/lint; 90 turns ≈ 40 tool calls of headroom above typical |
| reviewer | 60 | 3.00 | 75 | read-only but adversarial: reads diff + linked issue + prior reviews, runs build/test/lint once |
| fixer | 60 | 3.00 | 75 | scoped to one review's findings; usually well under |
| merger | 45 | 1.50 | 60 | conflict resolution only; aborts cleanly with `WALL:` on unresolvable conflicts |

`--max-price` is the cost brake; `--max-tokens` is deliberately **not set** (price already
bounds cumulative token spend, and a separate token cap adds a failure mode without adding
protection). Hard ceiling independent of vibe: the GitHub job timeout (`timeout-minutes`)
set 15 min above each role's wall-clock target (90/60/60/45 min), so a wedged process cannot
burn the 6-hour job limit. Note: there is no vibe-level `--time-limit` flag; the timeout is
the job's `timeout-minutes`, and hitting it shows as a red cancelled run, not a parseable outcome.
Expected real-world spend per happy-path PR (implement + 1–2 reviews + 1 fix + occasional
merge): roughly $5–15 total; the caps bound the worst case at ~$15 per role run.

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
GitHub trace. No silent stuck states. Every failure path ends in exactly one of:
(a) a `needs-human` label + marker escalation comment (`@chrthom`, reason, pointers),
(b) a benign no-op, or (c) an Actions-visible failed run that the dispatch backstop can re-tick.

The vibe exit code and stderr stop tag are the discriminators (`out/messages.json` transcript +
`out/vibe.stderr`):

| What failed | Detection | Handling (post-step, in code) |
| --- | --- | --- |
| model API outage / runner infra | exit 1, no `<vibe_stop_event>` tag on stderr | **retry once** via the GitHub re-run API (needs `actions: write` on the workflow's own `GITHUB_TOKEN` — fine-grained PATs cannot hold Actions permissions; reruns create no events, so the recursion guard does not apply); on second failure: escalate with reason + run link. Transient by nature |
| budget hit (turns/price) | exit 1 with `<vibe_stop_event>Turn limit of N reached</vibe_stop_event>` or `<vibe_stop_event>Price limit exceeded: $X > $Y</vibe_stop_event>` on stderr | escalate: label `needs-human`, comment the stop reason ("likely a rabbit hole or the issue is too large"), link the artifact. Never auto-retry: a budget hit means the task, not the run, is the problem |
| wall-clock timeout | job killed by `timeout-minutes` (no vibe exit code) | red run; the re-run backstop covers it |
| model refusal / other in-run error | exit 1, message on stderr, no stop tag | escalate with the stderr message; a human decides whether the task is genuinely unsafe |
| agent finished but outcome unparseable | exit 0, final message doesn't match the contract | escalate with reason "unparseable outcome" + link to the transcript artifact; the transcript is preserved for diagnosis |
| agent reported `WALL:` / `NO_PR:` | exit 0, parseable | the designed escalation: implementer comments its questions on the issue + labels it; fixer/merger escalate on the PR |
| workflow step failed *outside* vibe (npm ci, install, push rejected) | step exit code | normal Actions red run: visible on the run, GitHub can "re-run failed jobs"; if the same step fails twice, add a failure-branch to the post-step that escalates instead of leaving it red silently |

Per-role specifics:

- **implementer fails** → nothing exists yet on GitHub except the issue. Post-step comments on
  the issue ("dev-loop implementer failed: <reason>, run: <link>") and labels it `needs-human`.
  The issue is never lost; removing the label re-triggers the implementer with a fresh budget.
- **reviewer fails** → the PR sits ready-for-review (or draft) with no review. Post-step comments
  on the PR with the failure reason. Human can re-run the job or flip draft→ready to re-trigger.
  A ready PR with zero findings stays unmergeable by review policy, so nothing unsafe happens.
- **fixer fails** → the review's findings still stand; the PR simply doesn't progress. Post-step
  comments on the PR; the human can remove `needs-human` to re-trigger the fixer on the same review.
- **merger fails** → the PR stays `CONFLICTING`; CI's mergeability probe keeps showing it and
  every future `workflow_run` of `ci.yml` re-offers the merger dispatch (natural retry).
  Escalation only after repeated failure (track via a `dev-loop-retries` label or comment count).

Backstop: `workflow_dispatch` on each role workflow doubles as the manual retry button, and a
`workflow_dispatch` "tick" re-derives state from GitHub and re-dispatches anything stuck —
which is also the recovery path if a webhook event was ever missed.

## Implementation phases

1. **Branch `vibe/dev-loop-actions`** (this PR): plan document only (`docs/dev-loop.md`).
2. **Phase 1 — implementer only**: `dev-loop-implement.yml` + `implementer.md` prompt. Validate
   the whole design in isolation on 2–3 real open issues: event trigger → headless vibe run →
   draft PR with `Closes #<N>` → CI green → transcript artifact with sane cost. Human does
   the review part manually at this stage. Gate: no manual intervention needed beyond creating
   the issue, and cost per run within ~2x of the cap prediction.
3. **Phase 2**: `dev-loop-review.yml` + `dev-loop-fix.yml` + fixer chain + iteration cap.
   Validate the full CHANGES_NEEDED → fixer → reviewer cycle end-to-end.
4. **Phase 3**: `dev-loop-merge.yml` + `workflow_run` trigger. Soak test for a week.
5. **Phase 4**: budget calibration from accumulated transcript artifacts, reviewer prompt
   iteration, retry/failure-path drills (simulate API outage, budget cap, unparseable outcome).
6. **Cleanup**: close PR #80 as superseded.

## Acceptance criteria

- An open issue becomes a draft PR without human interaction; CI passes.
- Review runs exactly once per head SHA; pushes to draft PRs never trigger it.
- A push to a ready PR triggers re-review.
- Only a `CLEAN` review verdict sets a PR ready; nothing else ever does.
- `CHANGES_NEEDED` triggers the fixer exactly once; the fixer chains the reviewer only on
  success; the cycle escalates at 8 iterations, in code.
- A conflicted PR gets a merge commit resolving both sides, returns to draft, and is re-reviewed.
- `needs-human` parks an item; removing the label resumes it with a fresh budget.
- Every role run is bounded by `--max-turns`/`--max-price` and the job timeout; the transcript
  artifact preserves what happened within those bounds.
