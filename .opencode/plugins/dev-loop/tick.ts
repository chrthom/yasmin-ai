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
//
// The `expired` marker written by expireState is informational only (it lets `status` tell "expired"
// from "stopped"): it must never gate this decision, or a restarted loop (/dev-loop start sets
// enabled + a fresh startedAt but cannot know about the marker) would never tick again. After the
// expiry write, `enabled` is already false, which is what silences the loop; a fresh `startedAt`
// alone re-arms the budget, and an unrefreshed one simply expires again.
export function nextTickAction(ctx: TickContext): TickAction {
  const { state, now, orchestratorKnown, orchestratorIdle } = ctx;
  if (!state || state.enabled !== true) return 'none';
  if (state.startedAt !== undefined) {
    const startedAt = Date.parse(state.startedAt);
    if (!Number.isNaN(startedAt) && now - startedAt > LOOP_BUDGET_MS) return 'expire';
  }
  if (!orchestratorKnown || !orchestratorIdle) return 'none';
  return 'tick';
}

// The state the plugin writes back when the budget is exhausted. The agents map is preserved so the
// orchestrator's bookkeeping survives. The `expired` marker is informational (see nextTickAction):
// `/dev-loop start` clears it again, and a fresh `startedAt` re-arms the 7-day budget.
export function expireState(state: DevLoopState): DevLoopState {
  return { ...state, enabled: false, expired: true };
}

export interface WorktreeRecord {
  directory: string;
}

// An in-flight agent entry counts as dead after 180 minutes without a completion notification — the
// same dead-agent rule the skill's tick applies to its bookkeeping. The reaper uses it too, so a
// stopped or abandoned loop (whose entries are never removed by a tick) still gets its leftover
// worktrees reaped eventually. A missing or corrupt startedAt also counts as dead.
export const DEAD_ENTRY_MS = 180 * 60 * 1000;

export function entryIsDead(entry: AgentEntry | undefined, now: number): boolean {
  if (entry === undefined) return true;
  const startedAt = Date.parse(entry.startedAt);
  if (Number.isNaN(startedAt)) return true;
  return now - startedAt > DEAD_ENTRY_MS;
}

// Directories of dev-loop worktrees that can be reaped: their name matches the dev-loop pattern,
// they were created more than WORKTREE_GRACE_MS ago, and their state key has no live agent entry
// (absent, or older than the 180-minute dead-agent window). `now` is epoch milliseconds.
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
    if (!entryIsDead(agents[stateKey], now)) continue;
    dirs.push(worktree.directory);
  }
  return dirs;
}
