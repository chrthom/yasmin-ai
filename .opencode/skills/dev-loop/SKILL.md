---
name: dev-loop
description: Automated agentic development loop for chrthom/yasmin-ai. Orchestrates background subagents that implement open GitHub issues as draft PRs, review draft PRs with inline comments, and fix findings until a PR is clean (then marked ready for review) or needs a human.
metadata:
  opencode/autoinvoke: false
---

# Dev Loop Orchestrator

You are the **orchestrator**. You never implement, review or fix code yourself: you inspect GitHub
state, start background subagents, and track them. Keep your own turns short so the session goes back
to idle quickly, because the dev-loop plugin only sends its 1-minute tick while this session is idle.

Repo: `chrthom/yasmin-ai` (base branch `main`). All GitHub access goes through `gh`.

## Constants

| Name                | Value                           | Meaning                                         |
| ------------------- | ------------------------------- | ----------------------------------------------- |
| `MAX_ITERATIONS`    | 8                               | Max reviews per PR before escalating to a human |
| `MAX_PARALLEL`      | 4                               | Max subagents running at the same time          |
| `WALL_LABEL`        | `needs-human`                   | PR is parked until a human removes the label    |
| `STATE_FILE`        | `.opencode/dev-loop/state.json` | Loop switch + in-flight agent bookkeeping       |
| `REVIEW_MARKER`     | `<!-- dev-loop-review -->`      | First line of every review body this loop posts |
| `ESCALATION_MARKER` | `<!-- dev-loop-escalation -->`  | First line of every escalation comment          |

## Arguments

The invocation text tells you what to do:

- empty or `start`: setup, then run one tick immediately.
- `tick`: run one tick (this is what the dev-loop plugin's timer message asks for).
- `status`: print the state file and the current GitHub picture, change nothing.
- `stop`: set `"enabled": false` in `STATE_FILE`, report, done. Running agents are not killed. The
  plugin stops ticking within a minute.

## Setup (`start` only)

1. `gh auth status` must succeed; otherwise stop and tell the user.
2. Make sure the wall label exists:
   `gh label create needs-human --color B60205 --description "dev-loop: human decision required" 2>/dev/null || true`
3. Arm the timer by writing `STATE_FILE`. If it does not exist yet, create it as
   `{"enabled": true, "startedAt": "<now, ISO-8601>", "agents": {}}`. If it already exists, update
   `enabled` to `true`, refresh `startedAt` to now, and leave the `agents` map as it is — unless
   `enabled` was already `true`, in which case the timer is already armed: do not touch anything and
   just run one tick immediately. `"enabled": true` is what the plugin's timer keys on; `startedAt`
   starts the 7-day run budget (the plugin stops the loop and sends an expiry message when it is
   exhausted, mirroring the 7-day auto-expiry of a recurring cron).
4. Tell the user that ticks arrive as `[dev-loop] Timer tick` messages in this session, one per minute
   while the session is idle, and that the loop stops itself after 7 days or on `/dev-loop stop`.

## State file

`agents` is keyed by `issue-<N>` or `pr-<N>`:

```json
{ "role": "implementer|reviewer|fixer|merger", "sessionID": "...", "startedAt": "ISO-8601", "headSha": "..." }
```

- Add an entry right after launching a subagent; store the `sessionID` the subagent tool returns.
  Remove the entry when that subagent's completion notification arrives (background subagents notify
  this session when they finish — handle notifications at the start of the next tick, or right away if
  one arrives while idle).
- `headSha` is the PR head when a fixer or merger was started (empty for implementers).
- An entry older than 180 minutes without a notification counts as dead: remove it and let the tick
  re-evaluate that item from GitHub state (step 4 also treats a pushed `vibe/issue-<N>-*` branch as
  work in progress, so a slow implementer is not started twice).
- GitHub is the source of truth for everything else (iteration counts, findings, review status). Never
  store those in the state file.

## Tick

Do these steps in order. Count running agents as you go and never exceed `MAX_PARALLEL`; whatever does
not fit waits for a later tick.

### 1. Process finished agents

For each completion notification since the last tick: remove its state entry. If a fixer or merger
reported `WALL: <reason>`, escalate the PR as described in **Escalation**. If a fixer reported
`FIXED` but the PR head (`gh pr view <N> --json headRefOid`) still equals the entry's `headSha`, it
pushed nothing: escalate with reason "fixer made no change", otherwise the next tick would start the
same fixer again. The same applies to a merger: if it reported `MERGED` or `NO_CONFLICT` but the head
still equals `headSha` and GitHub reports `mergeable` as anything but `MERGEABLE` (`CONFLICTING`, or
still `UNKNOWN` after re-querying a few times), escalate with reason "merger could not resolve the
conflict". An implementer's `NO_PR`
needs nothing more: it already commented on the issue and labeled it. A reviewer's or fixer's
`CONFLICTING` needs nothing more either: step 2 picks the PR up.

### 2. Merge conflicts (all open PRs, draft and ready)

```bash
gh pr list --state open --limit 200 --json number,headRefName,isDraft,mergeable,labels,isCrossRepository
```

Skip a PR when it has the `needs-human` label, is cross-repository, or has a running agent in the
state file. Start a **merger** for every remaining PR whose `mergeable` is `CONFLICTING`. A PR whose
`mergeable` is `UNKNOWN` (GitHub computes it lazily after a push to the PR or to `main`) is left
alone this tick and re-checked on the next one. Conflict resolution goes first: draft PRs with
conflicts are not reviewed or fixed (step 3), and the merger turns a ready PR back into a draft so
the merge commit gets reviewed like any other change.

### 3. Draft PRs

```bash
gh pr list --state open --draft --limit 200 --json number,title,headRefName,headRefOid,mergeable,labels,isCrossRepository,statusCheckRollup
```

Skip a PR when it has the `needs-human` label, is cross-repository, has a running agent in the state
file (this includes a merger started in step 2), its `mergeable` is not `MERGEABLE`, `statusCheckRollup`
is empty (no checks have run/registered yet), or any entry of `statusCheckRollup` has a `status` other
than `COMPLETED` (CI may still push a `chore: auto-format` commit, which would make a review stale, and
an empty rollup must not be read as "CI done"). We gate on `status`, deliberately ignoring each check's
`conclusion`: this step only waits for CI to finish so a review does not race an auto-format push. A
check that completed with a failing `conclusion` is left for the reviewer to surface as a finding, not
skipped here. For each remaining PR, load the reviews and escalation
comments this loop posted (one JSON object per line; `--paginate` with a per-item `--jq` works across
pages):

```bash
gh api repos/chrthom/yasmin-ai/pulls/<N>/reviews --paginate \
  --jq '.[] | select(.body != null) | select(.body | startswith("<!-- dev-loop-review -->")) | {id, commit_id, submitted_at, verdict: ((.body | capture("(?m)^Verdict: (?<v>[A-Z_]+)") | .v) // "MISSING")}'
gh api repos/chrthom/yasmin-ai/issues/<N>/comments --paginate \
  --jq '.[] | select(.body | startswith("<!-- dev-loop-escalation -->")) | {id, created_at}'
```

Let `last` be the newest review, `esc` the newest escalation comment, and `count` the number of reviews
submitted after `esc` (all reviews if there is no `esc`). Removing `needs-human` after an escalation
therefore starts a fresh budget of `MAX_ITERATIONS` reviews. Then:

| Situation                                                                                  | Action                                                                                                    |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| no `last`, or `last.commit_id != headRefOid`                                               | `count >= MAX_ITERATIONS`? escalate. Else start **reviewer**                                              |
| `last.commit_id == headRefOid`, verdict `MISSING`                                          | escalate with reason "review without a verdict line"                                                      |
| `last.commit_id == headRefOid`, `Verdict: CLEAN`                                           | escalate with reason "CLEAN review but PR still draft" (the reviewer should already have marked it ready) |
| `last.commit_id == headRefOid`, `Verdict: CHANGES_NEEDED`                                  | start **fixer** with review id `last.id`                                                                  |
| `last.commit_id == headRefOid`, `Verdict: NEEDS_HUMAN`, `esc` older than `last` or missing | escalate                                                                                                  |
| `last.commit_id == headRefOid`, `Verdict: NEEDS_HUMAN`, `esc` newer than `last`            | a human answered and removed the label: start **fixer** with review id `last.id`                          |

A PR only leaves draft through a `Verdict: CLEAN` review: zero findings of any severity, including
minors and nits. Only the reviewer ever calls `gh pr ready` (its step 7, on a CLEAN review at the
unchanged head); the orchestrator never re-issues it — if a CLEAN review at the current head is left
in draft, it escalates. Never call `gh pr ready` in any other case.

### 4. Issues without a PR

```bash
gh issue list --state open --limit 200 --json number,title,labels
gh api graphql --paginate -f query='query($endCursor:String){repository(owner:"chrthom",name:"yasmin-ai"){issues(states:OPEN,first:100,after:$endCursor){nodes{number closedByPullRequestsReferences(first:10,includeClosedPrs:false){nodes{number state}}}}}}'
gh pr list --state open --limit 200 --json number,body,headRefName
```

An issue already has a PR if any of these hold: GraphQL lists an open linked PR; an open PR body
references it (`#<N>` as a whole token, e.g. `Closes #<N>`, `Fixes #<N>`, `#<N>`); an open PR branch
is named `vibe/issue-<N>-*`; a remote branch `vibe/issue-<N>-*` exists
(`git ls-remote --heads origin 'vibe/issue-*'`, an implementer may have pushed without opening the PR
yet); it has a running implementer in the state file. Also skip issues carrying the `needs-human`
label. Start an **implementer** for every other open issue.

### 5. Done?

Items carrying `needs-human` never keep the loop alive. If there are no running agents, no open PR
(without `needs-human`) is `CONFLICTING` or `UNKNOWN`, no draft PR (without `needs-human`) needed an
action or was waiting for CI this tick, and no issue (without `needs-human`) was without a PR:
set `"enabled": false` in `STATE_FILE` (this disarms the plugin's timer), and give the user a final
summary (PRs marked ready, PRs escalated, issues covered). Otherwise end the turn with a one-line
status (`running: X | started this tick: Y | waiting: Z`). Do not wait for agents in the foreground.

## Escalation

The PR stays draft (a merger `WALL` already turned it into a draft). Then:

```bash
gh pr edit <N> --add-label needs-human
gh pr comment <N> --body-file <file>
```

Write the body file into `.opencode/dev-loop/` (gitignored, e.g. `.opencode/dev-loop/escalation-<N>.md`).
The comment's first line is `<!-- dev-loop-escalation -->`. It then mentions `@chrthom`, states the
reason (iteration cap of 8 reached, blocker that needs a decision, the fixer's or merger's `WALL:`
reason, or "fixer made no change"), lists the open findings or questions, and ends with: "Answer here
and remove the `needs-human` label to let the dev loop continue." A human removing the label resumes
the loop on the next tick: the review budget restarts, and a fixer started after the escalation reads
the human's answers in the PR comments.

## Subagent launches

The four roles are agent definitions in `.opencode/agents/` (`implementer`, `reviewer`, `fixer`,
`merger`). They carry the full instructions, restricted permissions, and the worktree isolation
(`worktree_create` + `session_move`, named `<stateKey>-<role>-<unix-milliseconds>`), so the launch
prompt only passes the parameters. Launch with the `subagent` tool, `agent` set to the role,
`background: true`:

| Role          | `prompt`                                                   |
| ------------- | ---------------------------------------------------------- |
| `implementer` | `Implement issue #<N>: <title>`                            |
| `reviewer`    | `Review PR #<N> at head commit <headRefOid>`               |
| `fixer`       | `Fix review <reviewId> on PR #<N>, branch <headRefName>`   |
| `merger`      | `Resolve merge conflicts on PR #<N>, branch <headRefName>` |

Do not add further instructions to these prompts; change the agent definitions instead. You do not
manage worktrees yourself: the dev-loop plugin reaps a role worktree automatically once its state key
no longer has an entry in the state file.
