// Tick and cleanup state machine of the dev-loop plugin. All logic is pure: index.ts owns the
// filesystem, timers, and OpenCode session calls, and this module decides what a timer fire should
// do based on the loop state file (`.opencode/dev-loop/state.json`) and what the event stream has
// told the plugin about the orchestrator session.

export const STATE_FILE = '.opencode/dev-loop/state.json';

// The orchestrator only runs while its session is idle; one tick per minute is plenty.
export const TICK_INTERVAL_MS = 60_000;

// Like the recurring cron of the OpenClaude original (which auto-expires after 7 days), a started
// loop never runs longer than 7 days. The plugin stops the loop and notifies the orchestrator.
export const LOOP_BUDGET_MS = 7 * 24 * 60 * 60 * 1000;

export const TICK_MESSAGE =
  '[dev-loop] Timer tick. Run exactly one tick as described in the dev-loop skill ' +
  '(if its instructions are no longer in your context, load the dev-loop skill first). ' +
  'Do not wait for subagents; end your turn with the one-line status.';

export const EXPIRED_MESSAGE =
  '[dev-loop] The 7-day run budget is exhausted. The loop has been stopped ' +
  '("enabled": false in the state file). Run /dev-loop start to begin a fresh loop.';

// Worktree names of the dev-loop agents: <stateKey>-<role>-<unix-millis>, e.g.
// `issue-12-implementer-1751020800000` or `pr-80-fixer-1751020800000`. The plugin reaps such
// worktrees once their state key no longer has a running agent entry.
export const WORKTREE_NAME_PATTERN = /^((?:issue|pr)-\d+)-(?:implementer|reviewer|fixer|merger)-(\d+)$/;

// Grace period before an orphaned worktree may be reaped: freshly launched agents have an entry in
// the state file, but a dead-agent cleanup (see the skill's 180-minute rule) can race a worktree
// that was created moments ago.
export const WORKTREE_GRACE_MS = 30 * 60 * 1000;

export interface AgentEntry {
  role: string;
  sessionID: string;
  startedAt: string;
  headSha?: string;
}

export interface DevLoopState {
  enabled?: boolean;
  startedAt?: string;
  expired?: boolean;
  agents?: Record<string, AgentEntry>;
}

// Parses the state file. Returns null when the file is missing, unreadable, or not a JSON object:
// a missing state file means "loop stopped", the same as enabled !== true.
export function parseState(raw: string | null): DevLoopState | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as DevLoopState;
}

export type TickAction = 'tick' | 'expire' | 'none';

export interface TickContext {
  state: DevLoopState | null;
  now: number;
  orchestratorKnown: boolean;
  orchestratorIdle: boolean;
}

// What the timer should do on this fire:
// - `tick`: send one tick to the orchestrator session.
// - `expire`: the 7-day budget is exhausted; stop the loop and tell the orchestrator.
// - `none`: not armed, nobody to tick, or the orchestrator is busy.
export function nextTickAction(ctx: TickContext): TickAction {
  const { state, now, orchestratorKnown, orchestratorIdle } = ctx;
  if (!state || state.enabled !== true) return 'none';
  if (state.expired === true) return 'none';
  if (state.startedAt !== undefined) {
    const startedAt = Date.parse(state.startedAt);
    if (!Number.isNaN(startedAt) && now - startedAt > LOOP_BUDGET_MS) return 'expire';
  }
  if (!orchestratorKnown || !orchestratorIdle) return 'none';
  return 'tick';
}

// The state the plugin writes back when the budget is exhausted. The agents map is preserved so the
// orchestrator's bookkeeping survives; only the switch is flipped (plus the marker, so a restart of
// the loop with /dev-loop start resets it via a fresh startedAt).
export function expireState(state: DevLoopState): DevLoopState {
  return { ...state, enabled: false, expired: true };
}

export interface WorktreeRecord {
  directory: string;
}

// Directories of dev-loop worktrees that can be reaped: their name matches the dev-loop pattern,
// their state key has no running agent entry, and they were created more than WORKTREE_GRACE_MS ago.
// `now` is epoch milliseconds.
export function orphanedWorktrees(
  worktrees: readonly WorktreeRecord[],
  state: DevLoopState | null,
  now: number,
  graceMs: number = WORKTREE_GRACE_MS
): string[] {
  const agents = state?.agents ?? {};
  const dirs: string[] = [];
  for (const worktree of worktrees) {
    const name = worktree.directory.split('/').pop() ?? '';
    const match = WORKTREE_NAME_PATTERN.exec(name);
    if (!match) continue;
    const stateKey = match[1]; // <stateKey>-<role>-<unix-millis>
    const created = Number(match[2]);
    if (Number.isNaN(created) || now - created < graceMs) continue;
    if (agents[stateKey] !== undefined) continue;
    dirs.push(worktree.directory);
  }
  return dirs;
}
