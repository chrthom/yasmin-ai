#!/usr/bin/env bash
# Called with "install" or "run <rendered-prompt>". The workflows provide the
# budgets, config directory, credentials and GITHUB_OUTPUT in the environment.

if [ "$1" = "install" ]; then
  # The v2 installer installs to ~/.opencode/bin; the v1 installer cannot
  # reach 2.x releases. The invocation below is verified against this version.
  curl -fsSL https://opencode.ai/v2/install | bash -s -- --version "$OPENCODE_VERSION"
  export PATH="$HOME/.opencode/bin:$PATH"
  command -v opencode
  opencode --version | grep -F "$OPENCODE_VERSION" || {
    echo "::error::Installed opencode version does not match the expected $OPENCODE_VERSION - verify the invocation against the new CLI surface before rerunning"
    exit 1
  }
  exit 0
fi

if [ "$1" != "run" ] || [ "$#" -ne 2 ]; then
  echo "Usage: opencode-runner.sh install | run <rendered-prompt>" >&2
  exit 2
fi

export PATH="$HOME/.opencode/bin:$PATH"
mkdir -p "$OPENCODE_CONFIG_DIR"
# Pin the websearch provider only when a key is configured.
if [ -n "$TAVILY_API_KEY" ]; then
  printf '{"websearch": {"provider": "tavily"}}\n' > "$OPENCODE_CONFIG_DIR/opencode.jsonc"
  echo "opencode.jsonc: websearch provider pinned to tavily"
else
  echo "TAVILY_API_KEY not set; websearch/webfetch stay disabled"
fi

# Consume the JSON stream, stopping on a failed-tool streak, step budget or
# cost-weighted token budget (input + output + cache.write + 0.1 * cache.read).
run_watchdog() {
  streak=0
  steps=0
  tokens=0
  jq --unbuffered -c '
    select(.type == "tool_use" or .type == "step_start" or .type == "step_finish")
    | if .type == "tool_use" then {
          k: "tool",
          status: (.part.state.status // ""),
          exit: (.part.state.metadata.metadata.exit // 0)
        }
      elif .type == "step_start" then { k: "step" }
      else {
          k: "tokens",
          t: (
            (.part.tokens.input // 0)
            + (.part.tokens.output // 0)
            + (.part.tokens.cache.write // 0)
            + (0.1 * (.part.tokens.cache.read // 0))
          )
        }
      end' 2>/dev/null \
  | while IFS= read -r entry; do
      k="$(printf '%s' "$entry" | jq -r '.k')"
      case "$k" in
        step)
          steps=$((steps + 1))
          if [ "$steps" -ge "$MAX_TURNS" ]; then
            echo "watchdog: step limit $MAX_TURNS reached - killing opencode"
            kill -TERM "$1" || true
            exit 99
          fi
          ;;
        tokens)
          tt="$(printf '%s' "$entry" | jq -r '.t')"
          tokens=$(jq -n --argjson a "$tokens" --argjson b "$tt" '$a + $b | floor')
          if [ "$tokens" -ge "$MAX_TOKENS" ]; then
            echo "watchdog: token limit $MAX_TOKENS reached - killing opencode"
            kill -TERM "$1" || true
            exit 99
          fi
          ;;
        tool)
          status="$(printf '%s' "$entry" | jq -r '.status')"
          exit_code="$(printf '%s' "$entry" | jq -r '.exit')"
          if [ "$status" = "failed" ] || { [ "$status" = "completed" ] && [ "$exit_code" != "0" ] && [ -n "$exit_code" ] && [ "$exit_code" != "null" ]; }; then
            streak=$((streak + 1))
            echo "watchdog: failed tool call streak = $streak"
            if [ "$streak" -ge "$MAX_DENIED_STREAK" ]; then
              echo "watchdog: $streak consecutive failed tool calls - killing opencode"
              kill -TERM "$1" || true
              exit 99
            fi
          elif [ "$status" = "completed" ]; then
            streak=0
          fi
          ;;
      esac
    done
}

set -o pipefail
set +e
# The process substitution execs timeout, so $! identifies only this run's
# supervisor. TERM makes timeout signal its child process group, not bash -c.
exec {stream_fd}< <(exec timeout --signal=TERM --kill-after=60 "$TIME_LIMIT_SEC" \
  opencode run --standalone --format json --auto --model mistral/zai-glm-5-3 \
    "$(cat "$2")" \
  2> out/opencode.stderr)
agent_pid=$!
tee out/stream.ndjson <&"$stream_fd" | run_watchdog "$agent_pid"
rc=$?
exec {stream_fd}<&-
wait "$agent_pid"
agent_rc=$?
# Preserve the rightmost stream/watchdog failure (especially 99), otherwise
# report the agent/timeout status just as the original pipefail pipeline did.
if [ "$rc" = "0" ]; then
  rc=$agent_rc
fi
set -e
echo "rc=$rc" >> "$GITHUB_OUTPUT"
echo "--- opencode stderr ---"
cat out/opencode.stderr || true
if [ "$rc" = "99" ]; then
  echo "stopped_by_watchdog=true" >> "$GITHUB_OUTPUT"
fi
exit 0
