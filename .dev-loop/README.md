# Dev Loop on GitHub Actions + Mistral Vibe — Implementation Plan

Successor design to PR #80 (`.openclaude/` skill/agents/guard): GitHub Actions replaces the
orchestrator (cron tick, `state.json`, dead-agent heuristics, `guard-bash.mjs`); the agentic
work (implement / review / fix / merge-conflicts) stays with a real coding-agent harness —
Mistral Vibe — executed headless on the workflow runner, with its full local toolset
(edit files, `npm run build`, `npm test`, `npm run lint`, `npx prettier`).

Source of truth stays GitHub (issues, PRs, reviews, labels) — exactly as PR #80 already
postulated. No local session, no state file, no 1-minute timer.

## Architecture

```
GitHub events ──> dev-loop dispatch workflow ──> role job (runner)
                     (rules, budgets,            ├─ checkout, Node 22, npm ci
                      concurrency, tokens)        ├─ compose role prompt
                                                 ├─ vibe --prompt-file <role>.md --auto-approve
                                                 │      --max-price/--max-turns/--time-limit
                                                 │      --enabled-tools <per role> --output-dir out/
                                                 ├─ commit / push / gh (per-role token)
                                                 └─ upload out/export.json as artifact
```

| PR #80 concept | Replacement |
| --- | --- |
| 1-min cron tick + `state.json` | event triggers + a slow scheduled sweep |
| `MAX_PARALLEL` | `concurrency` groups per PR/issue |
| dead-agent heuristic (180 min) | workflow run status queryable via `gh run list` |
| `guard-bash.mjs` (738 lines + 167 tests) | branch protection + per-role fine-grained tokens + `--enabled-tools` |
| `FIXED` / `WALL:` final-message convention | `export.json` stop reason + workflow step exit codes |
| CI-completion polling (`statusCheckRollup`) | trigger on `workflow_run` completion of `ci.yml` |

## New files

```
.github/workflows/dev-loop-dispatch.yml     triggers + sweep + dispatch (reusable workflow call)
.github/workflows/dev-loop-implement.yml    issue -> draft PR
.github/workflows/dev-loop-review.yml       draft PR -> one COMMENT review (marker-prefixed)
.github/workflows/dev-loop-fix.yml         review findings -> fix commits
.github/workflows/dev-loop-merge.yml       conflict resolution via merge commit
.dev-loop/prompts/implementer.md           role prompt (ported from .openclaude/agents/*.md)
.dev-loop/prompts/reviewer.md
.dev-loop/prompts/fixer.md
.dev-loop/prompts/merger.md
.dev-loop/README.md                         this plan, operation, runbook
```

Role prompts port nearly verbatim from PR #80's agent definitions; the gh-guard boilerplate
shrinks to a few rules (see Guardrails).

## Workflows

### `dev-loop-dispatch.yml` (the orchestrator)

Triggers:

- `schedule`: `*/15 * * * *` — the sweep (GitHub's floor is 5 min; 15 is enough because
  events cover the fast path).
- `issues: [opened, reopened, edited]` — dispatch implementer for the issue.
- `pull_request: [opened, synchronize, reopened, ready_for_review, converted_to_draft]`
  (own-repo PRs only) — dispatch reviewer for draft PRs.
- `pull_request_review: [submitted]` — dispatch fixer for marker-prefixed reviews.
- `workflow_run` (workflow = `ci.yml`, completed) — re-check PRs that were waiting for CI.
- `issues: [labeled, unlabeled]` / `pull_request_target: [labeled, unlabeled]` — removing
  `needs-human` resumes the loop (fresh `MAX_ITERATIONS` budget, as in PR #80).
- `workflow_dispatch` — manual tick (`/dev-loop status` equivalent: `gh run list --workflow dev-loop-dispatch.yml`).

Sweep logic (a small `node` or `bash + gh + jq` step, ~100 lines, unit-tested):

1. Open PRs with `mergeable: CONFLICTING` and no `needs-human` -> dispatch merger.
2. Draft PRs, mergeable, no running role job (query `gh run list`), no review newer than
   head SHA -> dispatch reviewer (respecting the 8-review cap per escalation epoch).
3. Ready PRs whose latest marker review is `CHANGES_NEEDED`-stale -> dispatch fixer.
4. Open issues without linked PR / `vibe/issue-<N>-*` branch / running implementer -> dispatch implementer.

Dispatch = `workflow_dispatch`-call to the role workflow (via `gh workflow run` or a
reusable workflow with `workflow_call`), parameters: issue/PR number, branch, review id.
Concurrency: `concurrency: group: dev-loop-pr-<N>` / `dev-loop-issue-<N>`, `cancel-in-progress: false`.

### Role jobs (all four share one skeleton)

```yaml
permissions:
  contents: write        # fixer/merger/implementer only
  pull-requests: write   # reviewer gets a read-only token instead
concurrency:
  group: dev-loop-pr-${{ inputs.pr }}
steps:
  - uses: actions/checkout@v4        # PR ref / issue -> main; token: per-role PAT
  - uses: actions/setup-node@v4      # node 22, npm cache (mirrors ci.yml)
  - run: npm ci
  - run: curl -LsSf https://mistral.ai/vibe/install.sh | bash
  - run: vibe --prompt-file .dev-loop/prompts/<role>.md --auto-approve \
        --max-turns 40 --max-price 3 --time-limit 3300 \
        --enabled-tools <role allowlist> \
        --output-dir out/ && echo "OUTCOME=finished" >> $GITHUB_ENV
    env:
      MISTRAL_API_KEY: ${{ secrets.MISTRAL_API_KEY }}
      GH_TOKEN: ${{ secrets.DEV_LOOP_TOKEN_<ROLE> }}
      DEV_LOOP_ARGS: <pr number, branch, review id>
  - uses: actions/upload-artifact@v4   # out/export.json (tiny) for audit: cost, stop reason
  - if: failure() || env.OUTCOME != 'finished'
    run: <escalation step: label needs-human + marker comment @chrthom>
```

The prompt file receives its parameters via `DEV_LOOP_ARGS` env; each role prompt ends with the
same instruction PR #80 used: a parseable final line (`FIXED|CONFLICTING|WALL: <reason>`,
`PR_URL|NO_PR: <reason>`, `<VERDICT>|CONFLICTING`, `MERGED|NO_CONFLICT|WALL: <reason>`),
which a post-step extracts from `export.json` and translates into the next dispatch.

## Guardrails (replacing `guard-bash.mjs`)

- **Push safety**: branch protection on `main` (no direct pushes, no force-push, PRs only) —
  the same real enforcement PR #80 itself cited; a per-repo fine-grained PAT with only
  `contents:write` + `pull-requests:write` bounds everything else.
- **Reviewer is read-only by construction**: its job runs with a read-only token — stronger
  than a command-text parser. It also gets no edit tools: `--enabled-tools read,grep,glob,bash`
  is not enough alone (bash can write), so the read-only token is the actual guarantee.
- **Own-repo PRs only**: `if: github.event.pull_request.head.user.id == github.repository_owner.id`
  on all `pull_request` triggers; never `pull_request_target`. Fork PRs are skipped, as in PR #80.
- **Draft-only PRs**: the implementer prompt opens drafts; only a `CLEAN` review verdict may
  run `gh pr ready` (reviewer job, post-step).
- **Budgets**: `--max-price` / `--max-turns` / `--time-limit` per role run — a runaway agent
  costs at most a fixed amount; PR #80 had no such brake.
- Kept as prompt rules only: "never rebase, merge commits only" (merger), "fix findings
  minimally" (fixer).

## Secrets & settings

- `MISTRAL_API_KEY` — Actions secret (public repo: masked in logs).
- `DEV_LOOP_TOKEN_IMPLEMENTER/FIXER/MERGER` — fine-grained PAT, this repo only,
  `contents:write`, `pull-requests:write`. One token shared by the three write roles is fine;
  reviewer gets `secrets.GITHUB_TOKEN` with `permissions: pull-requests: read` (still enough
  to post a review via a dedicated comment step? No — reviews are posted by the workflow
  step from `export.json`, not by the agent, so read-only holds).
- `needs-human` label (as PR #80), colors and semantics unchanged.
- Enable Actions on the repo; public repo => hosted runners free and unlimited; optional
  self-hosted runner on the Synology later (zero minutes cost, key stays on LAN).

## Implementation phases

1. **Branch `vibe/dev-loop-actions` off `main`** (independent of PR #80; PR #80 stays open for
   reference and is closed superseded once this lands).
2. **Phase 1 — skeleton**: role prompts ported from PR #80 (minus guard boilerplate),
   `dev-loop-review.yml` + `dev-loop-dispatch.yml` (sweep + reviewer path only).
   Validate on a scratch issue + hand-made draft PR.
3. **Phase 2 — implementer & fixer**: issue dispatch, draft PR creation, review->fix cycle,
   escalation on non-`finished` outcomes. Validate the full loop on 2–3 real issues.
4. **Phase 3 — merger & CI handoff**: conflict sweep, `workflow_run` trigger, draft/ready
   lifecycle. Soak test: run the loop for a week with `MAX_ITERATIONS = 8`.
5. **Phase 4 — quality tuning**: per-role `--max-price` calibration from `export.json` stats,
   reviewer prompt iteration, optional migration to a self-hosted runner.
6. **Cleanup**: close PR #80 as superseded; delete nothing of it on `main` (it never landed).

## Acceptance criteria

- An open issue becomes a draft PR without human interaction; CI passes.
- A draft PR receives exactly one marker review per head SHA; findings become fix commits.
- A `CLEAN` review marks the PR ready; nothing else does.
- `needs-human` parks an item; removing the label resumes it.
- A conflicted PR gets a merge commit resolving both sides, then goes back to draft for review.
- Every role run produces an `export.json` artifact with bounded cost; no run exceeds its budget.
