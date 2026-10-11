import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const GUARD = resolve(__dirname, '../../.openclaude/hooks/guard-bash.mjs');

let repo: string;
let remote: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

const run = (command: string, role?: string, toolName = 'Bash') => {
  const input = JSON.stringify({ tool_name: toolName, cwd: repo, tool_input: { command } });
  const res = spawnSync('node', role ? [GUARD, role] : [GUARD], { input, encoding: 'utf8' });
  return { blocked: res.status === 2, status: res.status, stderr: res.stderr };
};

const checkout = (branch: string) => git('checkout', '-q', '-B', branch);

// Like the fixer/merger agents: a uniquely named local branch tracking the PR branch on origin.
const trackPrBranch = (local: string, prBranch = 'vibe/issue-12-thing') => {
  git('fetch', '-q', 'origin');
  git('checkout', '-q', '-B', local, '--track', `origin/${prBranch}`);
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'guard-bash-'));
  remote = mkdtempSync(join(tmpdir(), 'guard-bash-remote-'));
  execFileSync('git', ['init', '-q', '--bare', remote]);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'main', 'main:vibe/issue-12-thing');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

describe('guard-bash.mjs global rules', () => {
  beforeEach(() => checkout('feature'));

  it.each([
    'git push --force origin feature',
    'git push -f',
    'git push -uf origin feature',
    'git push --force-with-lease',
    'git push --force-with-lease=feature:abc origin feature',
    'git push origin +feature',
    'git push origin main',
    'git push origin HEAD:main',
    'git push origin feature:refs/heads/main',
    'git push origin :main',
    'git push --all origin',
    'git push --mirror',
    'git push -d origin feature',
    'git push --delete origin feature',
    'git commit --no-verify -m x',
    'git commit -nm x',
    'git push --no-verify',
    'git -C . push origin main',
    'npm test && git push -f',
    'bash -c "git push origin main"',
    'FOO=1 git push --force',
    'echo `git push origin main`',
    'echo $(git push origin main)'
  ])('blocks %s', command => {
    expect(run(command).blocked).toBe(true);
  });

  it.each([
    'git push',
    'git push -u origin HEAD',
    'git push origin feature',
    'git push origin HEAD:feature',
    "git commit -m 'fix -n handling'",
    'git commit -m "mention --no-verify"',
    'git commit -am wip',
    'git log --oneline main',
    'git merge origin/main',
    'echo "git push -f"',
    'gh pr merge 5',
    'npm test'
  ])('allows %s', command => {
    expect(run(command).blocked).toBe(false);
  });

  it('blocks a plain push while main is checked out', () => {
    checkout('main');
    expect(run('git push').blocked).toBe(true);
    expect(run('git push origin HEAD').blocked).toBe(true);
  });

  it('ignores tools other than Bash and malformed input', () => {
    expect(run('git push -f', undefined, 'Read').blocked).toBe(false);
    const res = spawnSync('node', [GUARD], { input: 'not json', encoding: 'utf8' });
    expect(res.status).toBe(0);
  });

  it('explains why a command was blocked', () => {
    expect(run('git push -f').stderr).toContain('Force-pushing is forbidden');
  });
});

describe('guard-bash.mjs role rules', () => {
  beforeEach(() => checkout('vibe/issue-12-thing'));

  it('rejects unknown roles', () => {
    expect(run('ls', 'admin').blocked).toBe(true);
  });

  it.each([
    ['implementer', 'gh pr merge 5'],
    ['fixer', 'gh pr close 5'],
    ['merger', 'gh issue close 3'],
    ['reviewer', 'gh repo delete chrthom/yasmin-ai'],
    ['fixer', 'gh release create v1'],
    ['implementer', 'gh workflow run ci.yml'],
    ['fixer', 'gh secret set X'],
    ['reviewer', 'gh api repos/chrthom/yasmin-ai/git/refs/heads/x -X DELETE'],
    ['implementer', 'gh api repos/chrthom/yasmin-ai/pulls/5 -X PATCH -f state=closed'],
    ['fixer', "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'"],
    ['merger', 'git push origin --delete old'],
    ['fixer', 'git push origin other-branch'],
    ['merger', 'git push origin HEAD:other-branch'],
    ['fixer', 'git commit --amend --no-edit'],
    ['implementer', 'bash -c "gh pr merge 5"']
  ])('%s: blocks %s', (role, command) => {
    expect(run(command, role).blocked).toBe(true);
  });

  it.each([
    ['implementer', 'gh pr create --title x --body y'],
    ['implementer', 'gh pr ready 5'],
    ['implementer', 'gh api repos/chrthom/yasmin-ai/pulls/5/reviews -X POST --input r.json'],
    ['reviewer', 'git commit -m x'],
    ['reviewer', 'git push'],
    ['reviewer', 'git merge origin/main'],
    ['reviewer', 'gh pr ready 5 --undo'],
    ['reviewer', 'gh pr comment 5 --body x'],
    ['reviewer', 'gh api repos/chrthom/yasmin-ai/issues/5/comments -f body=x'],
    ['reviewer', 'npm install left-pad'],
    ['fixer', 'gh pr ready 5'],
    ['fixer', 'gh pr ready 5 --undo'],
    ['fixer', 'gh api repos/chrthom/yasmin-ai/pulls/5/reviews -X POST --input r.json'],
    ['fixer', 'git merge origin/main'],
    ['fixer', 'git pull origin main'],
    ['merger', 'gh pr ready 5'],
    ['merger', 'gh api repos/chrthom/yasmin-ai/pulls/5/reviews -X POST --input r.json'],
    ['merger', 'git commit -m "not a merge"'],
    ['implementer', 'gh pr create --draft=false --title x'],
    ['reviewer', 'yarn add left-pad'],
    ['reviewer', 'pnpm add left-pad'],
    ['reviewer', 'gh api repos/chrthom/yasmin-ai/pulls/5/reviews -X POST --input missing.json'],
    ['reviewer', 'gh api repos/chrthom/yasmin-ai/pulls/5/reviews -X POST --input -'],
    [
      'reviewer',
      "gh api repos/chrthom/yasmin-ai/pulls/5/reviews -f event=APPROVE -f body='<!-- dev-loop-review -->'"
    ],
    ['reviewer', 'gh api repos/chrthom/yasmin-ai/pulls/5/reviews -f event=COMMENT -f body=unmarked'],
    ['merger', 'git rebase origin/main'],
    ['merger', 'git merge --squash origin/main'],
    ['merger', 'git merge --ff-only origin/main'],
    ['merger', 'git pull --rebase origin main'],
    ['merger', 'git cherry-pick abc123'],
    ['merger', 'git reset --hard origin/main'],
    ['merger', 'git -c pull.rebase=true pull'],
    ['fixer', 'git -c pull.rebase=true pull'],
    ['fixer', 'git config pull.rebase true'],
    ['merger', 'git config --add merge.ff only'],
    ['fixer', 'git config branch.main.mergeOptions --rebase'],
    ['fixer', 'git -c branch.main.mergeOptions=--rebase merge origin/main'],
    ['fixer', 'git config branch.vibe/issue-12-thing.mergeOptions --rebase'],
    ['fixer', 'git -c alias.p=push p origin main'],
    ['fixer', 'git reset --hard origin/main'],
    ['fixer', 'git reset --soft origin/vibe/issue-12-thing'],
    ['implementer', 'git reset --hard main'],
    ['reviewer', 'npm isntall left-pad'],
    ['reviewer', 'npm it left-pad'],
    ['reviewer', 'npm install-test left-pad'],
    ['reviewer', 'npm un typescript'],
    ['reviewer', 'npm link ../other'],
    ['reviewer', 'npm exec -- npm install left-pad'],
    ['reviewer', 'npx npm install left-pad'],
    ['reviewer', 'corepack pnpm add left-pad'],
    ['reviewer', 'yarn install'],
    ['reviewer', 'npx --package=left-pad prettier --check .'],
    ['reviewer', 'npx --package left-pad prettier --check .'],
    ['reviewer', 'npx -p left-pad tsc'],
    ['reviewer', 'npx --package=left-pad'],
    ['fixer', 'git pull -r'],
    ['fixer', 'git pull --rebase'],
    ['fixer', 'git pull --rebase origin vibe/issue-12-thing'],
    ['fixer', 'git rebase origin/vibe/issue-12-thing'],
    ['fixer', 'git rebase origin/main'],
    ['merger', 'git merge -s ours origin/main'],
    ['merger', 'git merge -X theirs origin/main'],
    ['merger', 'git merge --strategy-option=theirs origin/main'],
    ['merger', 'git merge origin/main --strategy ours'],
    ['merger', 'git merge -Xours origin/main'],
    ['merger', 'git pull -Xtheirs'],
    ['merger', 'git merge -sours origin/main'],
    ['merger', 'git merge -Xours origin/main --no-ff']
  ])('%s: blocks %s', (role, command) => {
    expect(run(command, role).blocked).toBe(true);
  });

  it.each([
    ['implementer', 'gh issue view 12 --comments'],
    ['implementer', 'git push -u origin HEAD'],
    ['implementer', 'gh pr create --draft --base main --title x --body-file b.md'],
    ['implementer', 'gh issue comment 12 --body-file q.md'],
    ['implementer', 'gh issue edit 12 --add-label needs-human'],
    ['reviewer', 'gh pr diff 5 | head -50'],
    ['reviewer', 'gh pr checkout 5'],
    ['reviewer', 'npm ci && npm run build && npm test && npm run lint'],
    ['reviewer', 'gh api repos/chrthom/yasmin-ai/pulls/5/reviews --paginate'],
    ['reviewer', 'gh pr ready 5'],
    ['reviewer', 'gh pr view 5 --json mergeable,mergeStateStatus'],
    ['reviewer', 'git fetch origin pull/5/head && git checkout --detach abc123'],
    ['implementer', 'gh pr create --draft=true --title x'],
    ['reviewer', 'npm install'],
    ['reviewer', 'npm run build -- --pretty'],
    ['reviewer', 'npx prettier --check .'],
    ['reviewer', 'npx jest src/__tests__/app.test.ts'],
    ['fixer', 'git config --get user.name'],
    ['fixer', 'git config user.email'],
    ['fixer', 'git reset src/app.ts'],
    ['fixer', 'git reset'],
    ['implementer', 'git reset HEAD -- src/app.ts'],
    ['fixer', 'git push origin HEAD:vibe/issue-12-thing'],
    ['fixer', 'gh api repos/chrthom/yasmin-ai/pulls/5/comments/99/replies -X POST -f body=done'],
    ['merger', 'gh pr ready 5 --undo'],
    ['merger', 'git fetch origin && git merge origin/main'],
    ['fixer', "gh api graphql -f query='query { viewer { login } }'"],
    ['reviewer', 'npx prettier --check .'],
    ['reviewer', 'npx --package=prettier prettier --check .'],
    ['reviewer', 'npx -p jest jest src/__tests__/app.test.ts'],
    ['fixer', 'git config --get branch.main.mergeOptions'],
    ['merger', 'git merge origin/main --no-ff'],
    ['merger', 'git merge --strategy=recursive origin/main']
  ])('%s: allows %s', (role, command) => {
    expect(run(command, role).blocked).toBe(false);
  });

  it('implementer: pushes only vibe/issue-<N> branches', () => {
    checkout('some-branch');
    expect(run('git push -u origin HEAD', 'implementer').blocked).toBe(true);
    expect(run('git push -u origin HEAD', 'fixer').blocked).toBe(false);
  });

  it('merger: allows committing while a merge is in progress', () => {
    checkout('merge-source');
    git('commit', '-q', '--allow-empty', '-m', 'source');
    checkout('merge-target');
    git('reset', '-q', '--hard', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'target');
    git('merge', '-q', '--no-commit', '--no-ff', 'merge-source');
    try {
      expect(run('git commit --no-edit', 'merger').blocked).toBe(false);
    } finally {
      git('merge', '--abort');
    }
  });

  it('merger: allows a fix commit on top of an unpushed merge, not after it was pushed', () => {
    checkout('side');
    git('reset', '-q', '--hard', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'side');
    trackPrBranch(`merger-pr-5-${Date.now()}`);
    git('commit', '-q', '--allow-empty', '-m', 'pr work');
    git('merge', '-q', '--no-ff', '--no-edit', 'side');
    expect(run('git commit -am "fix build after merge"', 'merger').blocked).toBe(false);
    expect(run('git push origin HEAD:vibe/issue-12-thing', 'merger').blocked).toBe(false);
    expect(run('git pull --no-rebase', 'merger').blocked).toBe(false);
    git('push', '-q', 'origin', 'HEAD:vibe/issue-12-thing');
    expect(run('git commit -am "unrelated"', 'merger').blocked).toBe(true);
  });

  describe('fixer on a local branch tracking the PR branch', () => {
    beforeEach(() => trackPrBranch(`fixer-pr-5-${Date.now()}`));

    it.each([
      'git pull --no-rebase',
      'git pull --no-rebase origin vibe/issue-12-thing',
      'git commit -m "address review" && git pull --no-rebase && git push origin HEAD:vibe/issue-12-thing',
      'git merge origin/vibe/issue-12-thing'
    ])('allows %s', command => {
      expect(run(command, 'fixer').blocked).toBe(false);
    });

    it.each([
      'git merge origin/main',
      'git merge FETCH_HEAD',
      'git fetch origin main && git merge FETCH_HEAD',
      'git merge origin/HEAD',
      'git merge refs/remotes/origin/main',
      'git pull origin main',
      'git pull --no-rebase origin other-branch',
      'git rebase origin/main',
      'git push origin HEAD:other-branch'
    ])('blocks %s', command => {
      expect(run(command, 'fixer').blocked).toBe(true);
    });
  });

  describe('reviewer review payload files', () => {
    const write = (name: string, payload: object) => writeFileSync(join(repo, name), JSON.stringify(payload));
    const post = (file: string) =>
      run(`gh api repos/chrthom/yasmin-ai/pulls/5/reviews -X POST --input ${file}`, 'reviewer');

    it('allows a marked COMMENT review', () => {
      write('ok.json', { event: 'COMMENT', body: '<!-- dev-loop-review -->\nVerdict: CLEAN', comments: [] });
      expect(post('ok.json').blocked).toBe(false);
    });

    it('blocks APPROVE and REQUEST_CHANGES', () => {
      write('approve.json', { event: 'APPROVE', body: '<!-- dev-loop-review -->\nVerdict: CLEAN' });
      write('rc.json', { event: 'REQUEST_CHANGES', body: '<!-- dev-loop-review -->\nVerdict: CLEAN' });
      expect(post('approve.json').blocked).toBe(true);
      expect(post('rc.json').blocked).toBe(true);
    });

    it('blocks a review without the marker', () => {
      write('nomarker.json', { event: 'COMMENT', body: 'Verdict: CLEAN' });
      expect(post('nomarker.json').stderr).toContain('<!-- dev-loop-review -->');
    });
  });

  describe('role rules enforce push safety', () => {
    it.each([['fixer'], ['merger'], ['implementer']])('blocks a force-push (%s)', role => {
      expect(run('git push -f origin HEAD', role).blocked).toBe(true);
      expect(run('git push --force-with-lease origin HEAD', role).blocked).toBe(true);
    });

    it.each([['reviewer'], ['merger']])('blocks a bulk push (%s)', role => {
      expect(run('git push --mirror origin', role).blocked).toBe(true);
      expect(run('git push --all origin', role).blocked).toBe(true);
    });
  });

  describe('role rules block hook-skipping commits', () => {
    it('blocks git commit -amn msg (n hidden in a short-flag cluster)', () => {
      expect(run('git commit -amn msg', 'fixer').blocked).toBe(true);
    });

    it('blocks git commit --no-verify', () => {
      expect(run('git commit --no-verify -m msg', 'fixer').blocked).toBe(true);
    });

    it('allows a normal commit', () => {
      expect(run('git commit -am "normal msg"', 'fixer').blocked).toBe(false);
    });
  });

  describe('role rules check substitution bodies', () => {
    it('allows the documented date substitution in branch names', () => {
      expect(run('git switch -c merger-pr-52-$(date +%s) --track origin/vibe/x', 'merger').blocked).toBe(
        false
      );
    });

    it('blocks backticks smuggling a blocked command', () => {
      expect(run('echo `git push origin main`', 'fixer').blocked).toBe(true);
    });

    it('blocks a $() body that would be blocked itself', () => {
      expect(run('echo $(git push origin main)', 'fixer').blocked).toBe(true);
      expect(run('git commit -m "$(gh pr merge 12)"', 'fixer').blocked).toBe(true);
    });
  });

  describe('role rules restrict push remotes', () => {
    it('blocks pushing to a URL', () => {
      expect(run('git push https://example.com/x.git HEAD', 'fixer').blocked).toBe(true);
    });

    it('allows pushing to origin', () => {
      expect(run('git push origin HEAD', 'fixer').blocked).toBe(false);
    });
  });

  describe('reviewer npx escapes', () => {
    it('blocks npx --call/--shell/-c even with an allowlisted package', () => {
      expect(run('npx -p prettier --call "git push origin main"', 'reviewer').blocked).toBe(true);
      expect(run('npx --shell "git push origin main"', 'reviewer').blocked).toBe(true);
      expect(run('npx -c "git push origin main"', 'reviewer').blocked).toBe(true);
    });

    it('still allows a plain allowlisted npx run', () => {
      expect(run('npx prettier --write file.ts', 'reviewer').blocked).toBe(false);
    });
  });

  describe('reviewer api method gating', () => {
    it('blocks PATCH on the reviews endpoint', () => {
      expect(
        run('gh api repos/chrthom/yasmin-ai/pulls/12/reviews -X PATCH -f body=x', 'reviewer').blocked
      ).toBe(true);
    });

    it('still allows POST on the reviews endpoint', () => {
      const file = join(repo, 'review-post.json');
      writeFileSync(
        file,
        JSON.stringify({ event: 'COMMENT', body: '<!-- dev-loop-review -->\nVerdict: CLEAN' })
      );
      expect(
        run(`gh api repos/chrthom/yasmin-ai/pulls/12/reviews -X POST --input ${file}`, 'reviewer').blocked
      ).toBe(false);
    });
  });
});
