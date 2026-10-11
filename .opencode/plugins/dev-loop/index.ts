// dev-loop plugin for OpenCode (chrthom/yasmin-ai).
//
// Ports the OpenClaude dev-loop infrastructure (PR #80) to OpenCode V2:
//
// 1. Bash guard: a `tool.execute.before` hook inspects every `shell` tool call. Sessions running one
//    of the dev-loop agents (`.opencode/agents/{implementer,reviewer,fixer,merger}.md`, identified by
//    the event's agent ID) get the full role rules; every other session gets the repo-wide rules
//    (no force-push, no push to main, no --no-verify, no pushes to unknown remotes, no command
//    substitution). Blocking = throwing, which surfaces the reason to the model as a tool error.
//
// 2. Loop timer: OpenCode has no cron tool, so the plugin IS the 1-minute timer of the dev-loop skill.
//    While `.opencode/dev-loop/state.json` has "enabled": true, it sends one synthetic tick message
//    per minute to the orchestrator session (the one that activated the dev-loop skill) — but only
//    while that session is idle, mirroring the OpenClaude cron that only fires on an idle session.
//    After 7 days the loop is stopped and the orchestrator is notified (the OpenClaude original
//    relied on its cron's 7-day auto-expiry for the same bound).
//
// 3. Worktree reaping: dev-loop agents isolate themselves in named worktrees
//    (<stateKey>-<role>-<timestamp>, created via the opencode worktree tools). The plugin reaps the
//    ones whose state key no longer has a running agent entry, so finished agents' worktrees (and
//    their node_modules) do not accumulate.
//
// The state file is owned by the orchestrator (the skill writes it); this plugin only reads it, plus
// the one expiry write (enabled: false). GitHub remains the source of truth for the loop itself.

import { Plugin } from '@opencode/plugin';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, ROLES, type Role } from './guard';
import {
  EXPIRED_MESSAGE,
  STATE_FILE,
  TICK_INTERVAL_MS,
  TICK_MESSAGE,
  expireState,
  nextTickAction,
  orphanedWorktrees,
  parseState,
  type DevLoopState
} from './tick';

interface SessionEventData {
  sessionID?: string;
  id?: string;
}

export default Plugin.define({
  id: 'dev-loop',
  async setup(ctx) {
    const statePath = join(ctx.location.directory, STATE_FILE);

    // ---------------------------------------------------------------------------------------------
    // 1. Bash guard (repo-wide + dev-loop role rules)

    await ctx.tool.hook('execute.before', async event => {
      if (event.tool !== 'shell') return;
      const input = event.input as { command?: unknown; workdir?: unknown } | null;
      const command = input?.command;
      if (typeof command !== 'string' || command.length === 0) return;
      const role = ROLES.includes(event.agent as Role) ? (event.agent as Role) : undefined;
      let cwd = typeof input?.workdir === 'string' ? input.workdir : undefined;
      if (cwd === undefined) {
        // The session's own location: the orchestrator runs in the project directory, dev-loop agents
        // have usually moved into their worktree (agents do that via session_move).
        try {
          const session = await ctx.session.get({ sessionID: event.sessionID });
          cwd = session.location.directory;
        } catch {
          cwd = ctx.location.directory;
        }
      }
      const reasons = check(command, { role, cwd });
      if (reasons.length > 0) {
        throw new Error(
          `Blocked by the dev-loop bash guard${role ? ` (${role} rules)` : ''}: ${reasons.join(' ')}`
        );
      }
    });

    // ---------------------------------------------------------------------------------------------
    // 2. Loop timer + orchestrator tracking

    let orchestratorID = (await ctx.storage.get('orchestrator')) as string | undefined;
    // Optimistic idle: ticks are delivered with "queue", so a tick sent while the orchestrator is
    // actually busy just waits in its inbox instead of interrupting. The skill.activated handler
    // marks it busy for the fresh-start path, and execution events keep the state current.
    let orchestratorIdle = true;

    const controller = new AbortController();
    const events = ctx.event.subscribe({ signal: controller.signal });
    void (async () => {
      for await (const event of events) {
        const data = (event.data ?? {}) as SessionEventData;
        const sessionID = data.sessionID;
        if (event.type === 'session.skill.activated' && data.id === 'dev-loop') {
          // A session outside this location cannot be ticked from here.
          const location = (event as { location?: { directory?: string } }).location;
          if (location?.directory !== undefined && location.directory !== ctx.location.directory) {
            continue;
          }
          orchestratorID = sessionID;
          orchestratorIdle = false;
          await ctx.storage.set('orchestrator', sessionID).catch(() => undefined);
          continue;
        }
        if (sessionID === undefined || sessionID !== orchestratorID) continue;
        if (event.type === 'session.execution.started') {
          orchestratorIdle = false;
        } else if (event.type === 'session.idle' || event.type === 'session.execution.failed') {
          orchestratorIdle = true;
        } else if (event.type === 'session.execution.interrupted') {
          orchestratorIdle = true;
        } else if (event.type === 'session.deleted') {
          orchestratorID = undefined;
          orchestratorIdle = false;
          await ctx.storage.remove('orchestrator').catch(() => undefined);
        }
      }
    })().catch(error => console.error('[dev-loop] event subscription failed:', error));

    const readStateFile = (): string | null => {
      try {
        return readFileSync(statePath, 'utf8');
      } catch {
        return null; // missing state file = loop not armed
      }
    };

    const writeStateFile = (state: DevLoopState): void => {
      try {
        writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
      } catch (error) {
        console.error('[dev-loop] could not update the state file:', error);
      }
    };

    const notifyOrchestrator = async (text: string): Promise<void> => {
      if (orchestratorID === undefined) return;
      try {
        // Queue, never steer: if our idle tracking is stale, the tick waits instead of interrupting.
        await ctx.session.synthetic({ sessionID: orchestratorID, text, delivery: 'queue' });
      } catch (error) {
        orchestratorIdle = true; // do not wedge the timer on a failed delivery
        console.error('[dev-loop] could not deliver a message to the orchestrator:', error);
      }
    };

    const pruneWorktrees = async (state: DevLoopState | null): Promise<void> => {
      try {
        const projectID = ctx.location.project.id;
        const worktrees = await ctx.worktree.list({ projectID });
        for (const directory of orphanedWorktrees(worktrees, state, Date.now())) {
          try {
            await ctx.worktree.remove({ projectID, directory, force: true });
            console.log('[dev-loop] reaped orphaned worktree:', directory);
          } catch (error) {
            console.error('[dev-loop] could not reap worktree', directory, error);
          }
        }
      } catch (error) {
        console.error('[dev-loop] worktree pruning failed:', error);
      }
    };

    const fire = async (): Promise<void> => {
      const state = parseState(readStateFile());
      await pruneWorktrees(state);
      const action = nextTickAction({
        state,
        now: Date.now(),
        orchestratorKnown: orchestratorID !== undefined,
        orchestratorIdle
      });
      if (action === 'expire') {
        // state is non-null whenever the decision is not "none" for a disabled/missing state.
        if (state !== null) writeStateFile(expireState(state));
        await notifyOrchestrator(EXPIRED_MESSAGE);
        return;
      }
      if (action === 'tick') {
        orchestratorIdle = false; // at most one tick until the next idle event
        await notifyOrchestrator(TICK_MESSAGE);
      }
    };

    const timer = setInterval(
      () => void fire().catch(error => console.error('[dev-loop] tick failed:', error)),
      TICK_INTERVAL_MS
    );

    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }
});
