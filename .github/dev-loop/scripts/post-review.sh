# Dev-loop reviewer post-step: the deterministic state machine after the opencode
# reviewer run (verdict parsing, review posting, stale-thread auto-resolve, fixer
# dispatch). Lives in this checked-in script - NOT inline in dev-loop-review.yml -
# because GitHub caps a `run:` block scalar at 21,000 chars, and this script sits
# right under that cap when inlined (the inline version once crossed it on a merge
# commit and silently invalidated the whole workflow - no Reviewer check-run at all,
# a full-loop stall, since the loop's escalation machinery lives in that very
# workflow). Grow this file, never the YAML scalar.
# Invoked as `run: bash .github/dev-loop/scripts/post-review.sh`; the workflow's
# `env:` block is the only bridge for GitHub expression contexts - everything the
# script needs (incl. OPENCODE_RC, from steps.opencode.outputs.rc) arrives as an
# environment variable. Assumes cwd = repo root with out/stream.ndjson and
# out/opencode.stderr from the reviewer run.
set -u
escalate() {
  gh pr edit "$PR_NUMBER" --add-label needs-human >/dev/null
  cat > /tmp/dev-loop-escalation.md <<EOF
<!-- dev-loop-escalation -->
@$REPO_OWNER dev-loop reviewer escalation: $1

PR: #${PR_NUMBER}
Run: ${RUN_URL}
EOF
  gh pr comment "$PR_NUMBER" --body-file /tmp/dev-loop-escalation.md >/dev/null
}

# OPENCODE_RC mirrors steps.opencode.outputs.rc from the workflow (an inline
# ${{ }} expression cannot survive in a checked-in script file).
rc="${OPENCODE_RC}"

if [ -z "$rc" ]; then
  # A pre-run step (install/render) failed before the agent ran.
  if [ "$RUN_ATTEMPT" = "1" ]; then
    echo "A step failed before the agent ran; leaving a red run for re-run failed jobs."
    exit 1
  fi
  escalate "a workflow step failed before the agent ran (twice); retry via workflow_dispatch (Actions -> Dev Loop Review -> Run workflow) or remove the needs-human label"
  exit 0
fi

# Per-step cost sum, rounded to cents (matches the watchdog cap; raw sums have float artifacts).
cost="$(jq -s '[.[].part.cost // 0] | add // 0 | (.*100 | round) / 100' out/stream.ndjson 2>/dev/null || echo 0)"
stderr_tail="$(tail -1 out/opencode.stderr 2>/dev/null || true)"

if [ "$rc" = "99" ]; then
  # Watchdog kill - never retry, escalate.
  escalate "reviewer killed by the watchdog (rc=99; failure streak / step cap ${MAX_TURNS} / token cap ${MAX_TOKENS}; cost: \$$cost) - see the opencode output artifact"
  exit 0
fi

if [ "$rc" = "124" ]; then
  # Deadline hit - never retry, escalate.
  escalate "reviewer stopped on the ${TIME_LIMIT_MIN} min deadline (rc=124, cost: \$$cost); see the opencode output artifact"
  exit 0
fi

if [ "$rc" = "1" ]; then
  # Exit 1 covers config/infra failures AND recovered tool errors; the VERDICT line is ground truth.
  contract_line="$(jq -r 'select(.type == "text") | .part.text' out/stream.ndjson 2>/dev/null \
    | grep -E '^(VERDICT: (CLEAN|CHANGES_NEEDED|NEEDS_HUMAN)|WALL:)' | tail -1 || true)"
  if [ -z "$contract_line" ]; then
    escalate "opencode failed (exit 1, no VERDICT line; cost: \$$cost, $stderr_tail); retry via workflow_dispatch if the stderr indicates a transient failure; see the opencode output artifact"
    exit 0
  fi
  echo "opencode exited 1 but the final message carries $contract_line; treating the session as completed (tool errors were recovered)."
  rc=0
fi

if [ "$rc" != "0" ]; then
  escalate "unexpected opencode exit code $rc (cost: \$$cost, $stderr_tail); see the opencode output artifact"
  exit 0
fi

# rc=0: the verdict lives in the final assistant message; this step posts the review with the PAT (last VERDICT line wins).
final_msg="$(jq -r 'select(.type == "text") | .part.text' out/stream.ndjson 2>/dev/null || true)"
outcome_line="$(printf '%s\n' "$final_msg" | awk 'NF { line = $0 } END { if (line) print line }')"

case "$outcome_line" in
  WALL:*)
    escalate "reviewer stopped early with ${outcome_line} (cost: \$$cost)"
    exit 0
    ;;
esac

verdict_num="$(printf '%s\n' "$final_msg" | grep -nE '^VERDICT: (CLEAN|CHANGES_NEEDED|NEEDS_HUMAN)$' | tail -1 | cut -d: -f1 || true)"
verdict_line="$(printf '%s\n' "$final_msg" | sed -n "${verdict_num:-0}p" || true)"
case "${verdict_line:-}" in
  VERDICT:\ CLEAN|VERDICT:\ CHANGES_NEEDED|VERDICT:\ NEEDS_HUMAN) ;;
  *)
    # rc=0 without a VERDICT line is usually a truncated run - retry once via workflow_dispatch (RETRY_COUNT prevents loops; no marker posted, so dedupe cannot block).
    if [ "$RETRY_COUNT" -lt 1 ] \
      && gh workflow run dev-loop-review.yml --ref main -f pr_number="$PR_NUMBER" -f retry=1; then
      echo "Unparseable outcome with no VERDICT line (cost: \$$cost); re-dispatching the reviewer once (retry=1). Transcript artifact preserved for diagnosis."
      exit 0
    fi
    escalate "unparseable outcome (exit 0, final message does not match the VERDICT contract; retry exhausted); transcript artifact preserved for diagnosis"
    exit 0
    ;;
esac
verdict="${verdict_line#VERDICT: }"
echo "Reviewer verdict: $verdict (cost: \$$cost)"

current_sha="$(gh pr view "$PR_NUMBER" --json headRefOid | jq -r '.headRefOid')"
if [ "$current_sha" != "$REVIEWED_SHA" ]; then
  echo "Head SHA moved ($REVIEWED_SHA -> $current_sha) since the review started; not acting on the stale verdict, re-dispatching the reviewer."
  if ! gh workflow run dev-loop-review.yml --ref main -f pr_number="$PR_NUMBER"; then
    escalate "failed to re-dispatch the reviewer after a stale head SHA ($REVIEWED_SHA -> $current_sha); retry via workflow_dispatch (Actions -> Dev Loop Review -> Run workflow)"
  fi
  exit 0
fi

# Findings JSON: the text after the VERDICT line (fenced or bare); missing/unparseable degrades to [].
# KEEP IN SYNC with dev-loop-fix.yml: its gates match this exact body shape (marker alone on line 1, bare `Verdict: <V>`), and the reviewer's dedupe greps the marker.
findings_json="$(printf '%s\n' "$final_msg" \
  | tail -n +"$(( ${verdict_num:-1} + 1 ))" \
  | sed -n '/^{/,$p' \
  | sed '/^```/d' \
  | jq 'try (select(type == "object") | .findings) catch null' 2>/dev/null)"
[ -n "$findings_json" ] || findings_json='[]'
# A non-CLEAN verdict with zero parsed findings is a parse failure - escalate, never post an empty findings review.
if [ "$verdict" != "CLEAN" ] \
  && [ "$(printf '%s' "$findings_json" | jq 'length' 2>/dev/null || echo 0)" = "0" ]; then
  escalate "unparseable outcome (exit 0, verdict $verdict but the findings JSON is missing or has zero findings); transcript artifact preserved for diagnosis"
  exit 0
fi
# Hybrid posting: diff-anchored findings become inline comments; the rest go into the review body.
body_findings="$(printf '%s' "$findings_json" \
  | jq -r '.[] | select((.path // empty | length) == 0 or (.line // 0) == 0) \
    | "- **[" + (.severity // "minor") + "]**" + (if .needs_human then " **[needs human]**" else "" end) + " " + (.message // .body // (. | tostring))' 2>/dev/null || true)"
body="<!-- dev-loop-review -->
Verdict: $verdict

dev-loop review of $REVIEWED_SHA (cost: \$$cost)."
if [ -n "$body_findings" ]; then
  body="$body

$body_findings"
fi
# Delete ONLY the token user's own stale pending review before posting (it 422-blocks every POST, PR #106): only zero-comment AND empty-body, or marker-prefixed (provably a loop leftover) reviews; a third party's or the owner's human draft is never touched.
pending_review_id="$(gh api "repos/${REPOSITORY}/pulls/$PR_NUMBER/reviews" --paginate \
  | jq -rs --arg owner "$REPO_OWNER" '(add // []) | [.[] | select(.state == "PENDING") | select(.user.login == $owner)] | first | .id // empty')"
if [ -n "$pending_review_id" ]; then
  # Fail closed: an unknown comment count/body means maybe a human draft - never destroyed on query failure; a marker-prefixed body proves loop origin regardless.
  pending_comments="$(gh api "repos/${REPOSITORY}/pulls/$PR_NUMBER/reviews/$pending_review_id/comments" \
    --jq 'length' 2>/dev/null || echo unknown)"
  pending_body="$(gh api "repos/${REPOSITORY}/pulls/$PR_NUMBER/reviews/$pending_review_id" \
    --jq '.body // ""' 2>/dev/null || echo unknown)"
  if { [ "$pending_comments" = "0" ] && [ -z "$(printf '%s' "$pending_body" | tr -d '[:space:]')" ]; } \
    || printf '%s' "$pending_body" | head -1 | grep -q '^<!-- dev-loop-review -->$'; then
    echo "Deleting stale pending review $pending_review_id before posting (comment- and body-less, or marker-prefixed i.e. provably a loop leftover, not a human draft; it would 422-block the POST)."
    gh api -X DELETE "repos/${REPOSITORY}/pulls/$PR_NUMBER/reviews/$pending_review_id" >/dev/null \
      || echo "::warning::Could not delete pending review $pending_review_id; the POST may 422."
  else
    echo "::warning::Pending review $pending_review_id carries ${pending_comments} draft comment(s) or a non-marker draft body (likely the owner's review draft in the GitHub UI); NOT deleting it. If it is a loop leftover, delete it manually - it 422-blocks the review POST."
  fi
fi
cat > /tmp/dev-loop-review.json <<EOF
{
  "commit_id": "$REVIEWED_SHA",
  "event": "COMMENT",
  "body": $(printf '%s' "$body" | jq -Rs .),
  "comments": $(printf '%s' "$findings_json" | jq '[.[] | select((.path // empty | length) > 0 and (.line // 0) > 0) | {path: .path, line: .line, side: "RIGHT", body: ("**[" + (.severity // "minor") + "]**" + (if .needs_human then " **[needs human]**" else "" end) + " " + (.message // .body // (. | tostring)))}]' 2>/dev/null || echo '[]')
}
EOF
if ! jq -e . /tmp/dev-loop-review.json >/dev/null 2>&1; then
  escalate "the review payload is not valid JSON (body/comments build failed); verdict was $verdict - see the run log"
  exit 0
fi
review_post_id="$(gh api "repos/${REPOSITORY}/pulls/$PR_NUMBER/reviews" -X POST --input /tmp/dev-loop-review.json --jq .id 2>&1 || true)"
case "$review_post_id" in
  ''|*[!0-9]*)
    # gh emits an error object, not an id, on failure - log it, never pass it on.
    echo "::warning::Inline review POST failed: $review_post_id"
    review_post_id=""
    ;;
esac
if [ -z "$review_post_id" ]; then
  # GitHub rejects inline comments outside the diff: retry once with every finding in the body (PR #80).
  all_findings="$(printf '%s' "$findings_json" \
    | jq -r '.[] | "- **[" + (.severity // "minor") + "]**" + (if .needs_human then " **[needs human]**" else "" end) + " " + ((.path // "?") + ":" + ((.line // 0) | tostring) + " ") + (.message // .body // (. | tostring))' 2>/dev/null || true)"
  fallback_body="<!-- dev-loop-review -->
Verdict: $verdict

dev-loop review of $REVIEWED_SHA (cost: \$$cost).

$all_findings"
  # jq -n (null input): without it an empty stdin yields zero documents (PR #113).
  jq -n --arg body "$fallback_body" --arg sha "$REVIEWED_SHA" \
    '{commit_id: $sha, event: "COMMENT", body: $body, comments: []}' \
    > /tmp/dev-loop-review.json
  if ! jq -e . /tmp/dev-loop-review.json >/dev/null 2>&1; then
    escalate "the fallback review payload is not valid JSON; verdict was $verdict - see the run log"
    exit 0
  fi
  review_post_id="$(gh api "repos/${REPOSITORY}/pulls/$PR_NUMBER/reviews" -X POST --input /tmp/dev-loop-review.json --jq .id 2>&1 || true)"
  case "$review_post_id" in
    ''|*[!0-9]*)
      escalate "the review post failed (inline and fallback both rejected: $review_post_id); verdict was $verdict - see the run log"
      exit 0
      ;;
  esac
fi

# Auto-resolve stale threads (findings this review no longer reports), best-effort and idempotent: only threads whose every comment is the token user's own and whose root belongs to a prior marker review; human inline comments are never touched.
# The marker-review lookup comes first and gates the run-start and token-user lookups: a PR with zero prior marker reviews has nothing to resolve, so those two API calls are skipped entirely (and a transient run-start failure cannot emit its misleading "leaving all prior review threads open" warning when there are none).
marker_review_ids="$(gh api "repos/${REPOSITORY}/pulls/$PR_NUMBER/reviews" --paginate \
  | jq -r --arg posted "${review_post_id:-0}" \
    '[.[] | select((.body // "") | startswith("<!-- dev-loop-review -->")) | .id | select((. | tostring) != $posted)] | join(" ")')"
if [ -n "$marker_review_ids" ]; then
  bot_login="$(gh api user --jq .login 2>/dev/null || true)"
  # Run-start cutoff (#121): only threads whose root AND latest comment predate this run are eligible; a mid-run thread may carry an unseen finding. The epoch comes from the REST run object (the github context has no run_started_at) and degrades to 0 = resolve nothing (fail closed).
  run_started_at="$(gh api "repos/${REPOSITORY}/actions/runs/${RUN_ID}" --jq '.run_started_at // empty' 2>/dev/null || true)"
  run_started_epoch=0
  if [ -n "$run_started_at" ]; then
    run_started_epoch="$(date -u -d "$run_started_at" +%s 2>/dev/null || echo 0)"
  fi
  if [ -z "$bot_login" ]; then
    # Without the token user's login no thread is safely resolvable.
    echo "::warning::Could not look up the token user (gh api user failed); skipping stale-thread auto-resolve."
  elif [ "$run_started_epoch" -le 0 ]; then
    # Fail closed: without a cutoff epoch nothing can be safely resolved (a stale open thread is harmless, resolving a fresh one unread is not).
    echo "::warning::Could not determine the workflow run start (run_started_at='${run_started_at}'); leaving all prior review threads open (fail closed)."
  else
    # Paged fetch: resolved threads stay in the connection, so an unpaged window misses the newest unresolved threads; a failed page logs a warning and ends the fetch (best-effort).
    threads_nodes="[]"
    after_cursor=""
    while :; do
      page_args=(-F owner="${REPOSITORY%%/*}" -F name="${REPOSITORY##*/}" -F number="$PR_NUMBER")
      if [ -n "$after_cursor" ]; then
        page_args+=(-f after="$after_cursor")
      fi
      page_json="$(gh api graphql -f query='
        query($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  isResolved
                  comments(first: 100) {
                    totalCount
                    nodes {
                      author { login }
                      createdAt
                      path
                      line
                      originalLine
                      pullRequestReview { databaseId }
                    }
                  }
                  lastComment: comments(last: 1) { nodes { createdAt } }
                }
              }
            }
          }
        }' "${page_args[@]}" 2>/dev/null || true)"
      page_info="$(printf '%s' "$page_json" \
        | jq -ce '.data.repository.pullRequest.reviewThreads
            | select(.nodes)
            | {nodes: .nodes, hasNextPage: .pageInfo.hasNextPage, endCursor: .pageInfo.endCursor}' 2>/dev/null || true)"
      if [ -z "$page_info" ]; then
        echo "::warning::Review-thread listing failed or came back unparseable; auto-resolve continues with the threads fetched so far."
        break
      fi
      threads_nodes="$(printf '%s' "$threads_nodes" \
        | jq -c --argjson page "$page_info" '. + $page.nodes' 2>/dev/null || echo "$threads_nodes")"
      if [ "$(printf '%s' "$page_info" | jq -r '.hasNextPage' 2>/dev/null)" != "true" ]; then
        break
      fi
      after_cursor="$(printf '%s' "$page_info" | jq -r '.endCursor' 2>/dev/null)"
    done
    # Keep only object entries in the live-findings guard: a non-object entry would abort the jq run.
    printf '%s' "$threads_nodes" \
      | jq -r --arg bot "$bot_login" --arg marker "$marker_review_ids" \
          --argjson live "$(printf '%s' "$findings_json" | jq 'if type == "array" then [.[] | select(type == "object")] else [] end')" \
          --argjson runStart "$run_started_epoch" '
        ($marker | split(" ") | map(tonumber)) as $marker_ids
        | .[]
        # >100 comments: bot-only cannot be verified from the truncated list - leave open.
        | select((.comments.totalCount // 100) <= 100)
        | select(.isResolved == false)
        # Run-start cutoff: root and latest comment must predate the run start.
        | select(try ((.comments.nodes[0].createdAt | fromdateiso8601) <= $runStart) catch false)
        | select(try ((.lastComment.nodes[0].createdAt | fromdateiso8601) <= $runStart) catch false)
        | select([.comments.nodes[].author.login] | all(. == $bot))
        | . as $t
        | select(($marker_ids | index($t.comments.nodes[0].pullRequestReview.databaseId)) != null)
        | $t.comments.nodes[0] as $c
        | ($c.line // $c.originalLine // 0) as $cl
        # .line may be null or non-numeric (agent-authored findings) - coerce before arithmetic.
        | select(([$live[] | select(.path == $c.path and ((((.line | tonumber? // 0) - $cl) | if . < 0 then (0 - .) else . end) <= 5))] | length) == 0)
        | .id' \
      | while read -r thread_id; do
          [ -n "$thread_id" ] || continue
          if gh api graphql \
            -f query='mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }' \
            -f id="$thread_id" >/dev/null 2>&1; then
            echo "Resolved stale review thread $thread_id (its finding is no longer reported)."
          else
            echo "::warning::Could not resolve review thread $thread_id; leaving it open."
          fi
        done
  fi
fi

case "$verdict" in
  CLEAN)
    echo "Verdict CLEAN: the PR stands ready for a human merge decision; no state change."
    exit 0
    ;;
  CHANGES_NEEDED)
    case "$review_post_id" in
      ''|*[!0-9]*)
        # A non-numeric id must never reach the fixer (PR #106: the 422 error JSON crashed the fixer gate).
        escalate "internal error: review_post_id is not numeric ('$review_post_id'); the review stands - retry the fixer via workflow_dispatch"
        exit 0
        ;;
    esac
    echo "Verdict CHANGES_NEEDED: dispatching the fixer with the exact review id ($review_post_id)."
    # Pass the posted review's id, not "latest": a second CHANGES_NEEDED review must not make the fixer act on the wrong one.
    if ! gh workflow run dev-loop-fix.yml --ref main \
      -f pr_number="$PR_NUMBER" -f review_id="$review_post_id"; then
      escalate "failed to dispatch the fixer for this CHANGES_NEEDED review; the review stands - retry via workflow_dispatch (Actions -> Dev Loop Fix -> Run workflow)"
    fi
    exit 0
    ;;
  NEEDS_HUMAN)
    escalate "review verdict NEEDS_HUMAN - at least one finding requires a human decision; see the review just posted"
    exit 0
    ;;
esac
