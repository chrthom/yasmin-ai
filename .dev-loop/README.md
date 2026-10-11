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
  job:      checkout → Node 22 → npm ci → vibe --prompt-file <role>.md
            --auto-approve --max-price --max-turns --time-limit
            --enabled-tools <role> --output-dir out/
  post-step: deterministic state machine from export.json
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
- **Per-run budgets**: `--max-price` / `--max-turns` / `--time-limit` on every role run; a
  budget stop escalates instead of chaining.
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
.dev-loop/prompts/implementer.md          role prompts (ported from PR #80's agent definitions,
.dev-loop/prompts/reviewer.md              minus gh-guard boilerplate; final line is a parseable
.dev-loop/prompts/fixer.md                  outcome: PR_URL|NO_PR:, VERDICT|CONFLICTING,
.dev-loop/prompts/merger.md                FIXED|CONFLICTING|WALL:, MERGED|NO_CONFLICT|WALL:)
.dev-loop/README.md                        this plan / runbook
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
  - run: vibe --prompt-file .dev-loop/prompts/<role>.md --auto-approve
        --max-turns 40 --max-price 3 --time-limit 3300
        --enabled-tools <role allowlist>
        --output-dir out/
    env:
      MISTRAL_API_KEY: ${{ secrets.MISTRAL_API_KEY }}
      GH_TOKEN: ${{ secrets.DEV_LOOP_TOKEN }}
      DEV_LOOP_ARGS: <pr/issue number, branch, review id>
  - uses: actions/upload-artifact@v4     # out/export.json: cost, stop reason, outcome
  - run: <post-step: state machine per table above, using the PAT>
```

The reviewer posts its review **from the post-step** (reads the agent's verdict out of
`export.json` / the final line, composes the marker-prefixed JSON, `gh api` posts it), so
the agent never needs review-writing API access.

## Secrets & settings

- `MISTRAL_API_KEY` — Actions secret (masked in logs on public repo).
- `DEV_LOOP_TOKEN` — fine-grained PAT, this repo only, `contents:write` + `pull-requests:write`
  (+ `issues:write` for the implementer's issue comments).
- `needs-human` label as in PR #80.
- Public repo: hosted runners free and unlimited. Optional later: self-hosted runner on the
  Synology (zero minutes cost, key stays on LAN).

## Implementation phases

1. **Branch `vibe/dev-loop-actions`** (this PR): plan document only.
2. **Phase 1**: role prompts + `dev-loop-review.yml` + `dev-loop-implement.yml`. Validate on a
   scratch issue: issue → draft PR → manual ready → review → verdict → state post-step.
3. **Phase 2**: `dev-loop-fix.yml` + fixer chain + iteration cap. Validate the full
   CHANGES_NEEDED → fixer → reviewer cycle on 2–3 real issues.
4. **Phase 3**: `dev-loop-merge.yml` + `workflow_run` trigger. Soak test for a week.
5. **Phase 4**: budget calibration from `export.json` artifacts, reviewer prompt iteration.
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
- Every role run produces a bounded `export.json`; no run exceeds its budget.
