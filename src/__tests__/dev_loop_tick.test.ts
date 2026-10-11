import {
  LOOP_BUDGET_MS,
  WORKTREE_GRACE_MS,
  expireState,
  nextTickAction,
  orphanedWorktrees,
  parseState,
  type WorktreeRecord
} from '../../.opencode/plugins/dev-loop/tick';

const state = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ enabled: true, startedAt: '2026-10-11T10:00:00.000Z', agents: {}, ...over });

const at = (offsetMs: number): number => Date.parse('2026-10-11T10:00:00.000Z') + offsetMs;

describe('parseState', () => {
  it('returns null for a missing file (loop not armed)', () => {
    expect(parseState(null)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseState('{enabled: true')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parseState('"armed"')).toBeNull();
    expect(parseState('[1, 2]')).toBeNull();
    expect(parseState('42')).toBeNull();
  });

  it('parses the orchestrator-written state file', () => {
    const parsed = parseState(state({ agents: { 'pr-80': { role: 'fixer' } } }));
    expect(parsed?.enabled).toBe(true);
    expect(parsed?.startedAt).toBe('2026-10-11T10:00:00.000Z');
    expect(parsed?.agents?.['pr-80']).toEqual({ role: 'fixer' });
  });
});

describe('nextTickAction', () => {
  it('does nothing while the loop is not armed', () => {
    expect(nextTickAction({ state: null, now: at(0), orchestratorKnown: true, orchestratorIdle: true })).toBe(
      'none'
    );
    expect(
      nextTickAction({
        state: parseState('{"enabled": false, "agents": {}}'),
        now: at(0),
        orchestratorKnown: true,
        orchestratorIdle: true
      })
    ).toBe('none');
  });

  it('ticks when armed, the orchestrator is known, and it is idle', () => {
    expect(
      nextTickAction({
        state: parseState(state()),
        now: at(0),
        orchestratorKnown: true,
        orchestratorIdle: true
      })
    ).toBe('tick');
  });

  it('never ticks a busy orchestrator or an unknown one', () => {
    expect(
      nextTickAction({
        state: parseState(state()),
        now: at(0),
        orchestratorKnown: true,
        orchestratorIdle: false
      })
    ).toBe('none');
    expect(
      nextTickAction({
        state: parseState(state()),
        now: at(0),
        orchestratorKnown: false,
        orchestratorIdle: true
      })
    ).toBe('none');
  });

  it('expires the loop once the 7-day budget is exhausted', () => {
    expect(
      nextTickAction({
        state: parseState(state()),
        now: at(LOOP_BUDGET_MS + 1),
        orchestratorKnown: true,
        orchestratorIdle: true
      })
    ).toBe('expire');
  });

  it('ticks while the budget lasts', () => {
    expect(
      nextTickAction({
        state: parseState(state()),
        now: at(LOOP_BUDGET_MS - 1),
        orchestratorKnown: true,
        orchestratorIdle: true
      })
    ).toBe('tick');
  });

  it('treats a missing or unparseable startedAt as unexpired (the orchestrator always writes one)', () => {
    expect(
      nextTickAction({
        state: parseState('{"enabled": true, "startedAt": "not-a-date", "agents": {}}'),
        now: at(LOOP_BUDGET_MS * 3),
        orchestratorKnown: true,
        orchestratorIdle: true
      })
    ).toBe('tick');
    expect(
      nextTickAction({
        state: parseState('{"enabled": true}'),
        now: at(0),
        orchestratorKnown: true,
        orchestratorIdle: true
      })
    ).toBe('tick');
  });

  it('never ticks or re-expires a loop the plugin already expired', () => {
    const expired = parseState(JSON.stringify(expireState(parseState(state()) ?? {})));
    expect(expired?.enabled).toBe(false);
    expect(expired?.expired).toBe(true);
    expect(
      nextTickAction({ state: expired, now: at(0), orchestratorKnown: true, orchestratorIdle: true })
    ).toBe('none');
  });
});

describe('expireState', () => {
  it('flips the switch and marks the expiry while preserving the bookkeeping', () => {
    const before = {
      enabled: true,
      startedAt: '2026-10-04T10:00:00.000Z',
      agents: {
        'issue-12': { role: 'implementer', sessionID: 'ses_x', startedAt: '2026-10-11T09:59:00.000Z' }
      }
    };
    const after = expireState(before);
    expect(after.enabled).toBe(false);
    expect(after.expired).toBe(true);
    expect(after.startedAt).toBe(before.startedAt);
    expect(after.agents).toEqual(before.agents);
    // the original object is not mutated
    expect(before.enabled).toBe(true);
  });
});

describe('orphanedWorktrees', () => {
  const now = 1_800_000_000_000;
  const dir = (name: string): WorktreeRecord => ({ directory: `/data/worktree/ab12cd/${name}` });
  const old = now - WORKTREE_GRACE_MS - 1;
  const fresh = now - 1_000;

  it('reaps a dev-loop worktree whose state key has no running agent', () => {
    const stateParsed = parseState(
      state({ agents: { 'pr-80': { role: 'fixer', sessionID: 'ses_f', startedAt: 'x' } } })
    );
    expect(
      orphanedWorktrees(
        [dir(`issue-12-implementer-${old}`), dir(`pr-80-fixer-${old}`), dir(`pr-81-reviewer-${old}`)],
        stateParsed,
        now
      )
    ).toEqual([dir(`issue-12-implementer-${old}`).directory, dir(`pr-81-reviewer-${old}`).directory]);
  });

  it('keeps fresh worktrees even without an agent entry (grace period)', () => {
    expect(orphanedWorktrees([dir(`issue-12-implementer-${fresh}`)], parseState(state()), now)).toEqual([]);
  });

  it('ignores worktrees that do not follow the dev-loop naming scheme', () => {
    expect(
      orphanedWorktrees([dir('login'), dir(`feature-x-${old}`), dir(`issue-12-hacker-${old}`)], null, now)
    ).toEqual([]);
  });

  it('reaps every dev-loop worktree when the state file is missing or unreadable', () => {
    expect(orphanedWorktrees([dir(`issue-12-implementer-${old}`)], null, now)).toEqual([
      dir(`issue-12-implementer-${old}`).directory
    ]);
    expect(orphanedWorktrees([dir(`issue-12-implementer-${old}`)], parseState('nope'), now)).toEqual([
      dir(`issue-12-implementer-${old}`).directory
    ]);
  });

  it('skips timestamps that are not numbers', () => {
    expect(orphanedWorktrees([dir('issue-12-implementer-notatime')], parseState(state()), now)).toEqual([]);
  });
});
