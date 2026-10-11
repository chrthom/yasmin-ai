// Bash-command guard for the dev-loop plugin: inspects every `shell` tool call and blocks git/gh
// commands the dev-loop roles must never run. The dev-loop plugin (index.ts) calls `check()` from a
// `tool.execute.before` hook and throws with the returned reasons, which surfaces the block to the
// model. Without a role, only the repo-wide rules apply (every session of this repository).
//
// This is a guardrail against mistakes, not a sandbox: it parses the command text, so deliberate
// obfuscation (command substitution, aliases, scripts) is not caught. Branch protection on GitHub is
// the real enforcement for main.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REPO = 'chrthom/yasmin-ai';
const MAIN = 'main';
export const ROLES = ['implementer', 'reviewer', 'fixer', 'merger'] as const;
export type Role = (typeof ROLES)[number];

// ---------------------------------------------------------------------------------------------------
// Shell parsing (good enough for the commands agents write; not a full shell grammar)

function splitCommands(src: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let cur = '';
  let has = false;
  const pushTok = () => {
    if (has) tokens.push(cur);
    cur = '';
    has = false;
  };
  const endSeg = () => {
    pushTok();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      cur += src.slice(i + 1, end);
      has = true;
      i = end + 1;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length && '"\\$`\n'.includes(src[i + 1])) {
          cur += src[i + 1];
          i += 2;
        } else {
          cur += src[i++];
        }
      }
      has = true;
      i++;
    } else if (c === '\\') {
      if (i + 1 < src.length && src[i + 1] !== '\n') {
        cur += src[i + 1];
        has = true;
      }
      i += 2;
    } else if (c === ' ' || c === '\t') {
      pushTok();
      i++;
    } else if (c === '&' && (/[<>]$/.test(cur) || src[i + 1] === '>')) {
      cur += c; // redirections like 2>&1 and &>file
      has = true;
      i++;
    } else if ('\n;&|()'.includes(c)) {
      endSeg();
      i++;
    } else if (c === '#' && !has) {
      while (i < src.length && src[i] !== '\n') i++;
    } else {
      cur += c;
      has = true;
      i++;
    }
  }
  endSeg();
  return segments;
}

function stripRedirects(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^(\d*|&)(>>?|<)/.test(t)) {
      if (/^(\d*|&)(>>?|<)&?$/.test(t)) i++; // bare operator: the target is the next token
      continue;
    }
    out.push(t);
  }
  return out;
}

const WRAPPERS = new Set(['env', 'command', 'time', 'nohup', 'sudo', 'exec', 'builtin']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const base = (t: string): string => t.split('/').pop() ?? t;
const isDefined = (t: string | undefined): t is string => t !== undefined;

interface Command {
  argv: string[];
  cwd: string | undefined;
}

// Yields { argv, cwd } for every simple command, following `cd` and descending into `sh -c` / `eval`.
function* commands(src: string, cwd: string | undefined): Generator<Command> {
  for (const raw of splitCommands(src)) {
    let argv = stripRedirects(raw);
    let i = 0;
    while (i < argv.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]) || WRAPPERS.has(argv[i]))) i++;
    argv = argv.slice(i);
    if (!argv.length) continue;
    const name = base(argv[0]);
    if (name === 'cd') {
      if (argv[1] && cwd) cwd = resolve(cwd, argv[1]);
      continue;
    }
    if (SHELLS.has(name)) {
      const c = argv.indexOf('-c');
      if (c >= 0 && argv[c + 1] !== undefined) yield* commands(argv[c + 1], cwd);
      continue;
    }
    if (name === 'eval') {
      yield* commands(argv.slice(1).join(' '), cwd);
      continue;
    }
    yield { argv: [name, ...argv.slice(1)], cwd };
  }
}

// ---------------------------------------------------------------------------------------------------
// git / gh argument parsing

function runGit(cwd: string | undefined, args: string[]): string | undefined {
  if (!cwd) return undefined;
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

const GIT_GLOBAL_WITH_VALUE = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);

interface GitCall {
  sub: string | undefined;
  rest: string[];
  cwd: string | undefined;
  config: string[];
}

function parseGit(args: string[], cwd: string | undefined): GitCall {
  let i = 0;
  const config: string[] = [];
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C') {
      if (cwd && args[i + 1]) cwd = resolve(cwd, args[i + 1]);
      i += 2;
    } else if (args[i] === '-c' || args[i] === '--config-env') {
      config.push(args[i + 1] ?? '');
      i += 2;
    } else if (GIT_GLOBAL_WITH_VALUE.has(args[i])) i += 2;
    else i++;
  }
  return { sub: args[i], rest: args.slice(i + 1), cwd, config };
}

const PUSH_WITH_VALUE = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec']);

interface Refspec {
  spec: string;
  force: boolean;
  deletes: boolean;
  dst: string | undefined;
}

interface PushCall {
  flags: string[];
  refspecs: Refspec[];
  current: string | undefined;
  upstream: string | undefined;
  force: boolean;
  deletes: boolean;
  bulk: boolean;
  targets: string[];
  remote: string | undefined;
}

function parsePush(rest: string[], cwd: string | undefined): PushCall {
  const flags: string[] = [];
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--') {
      pos.push(...rest.slice(i + 1));
      break;
    }
    if (t.startsWith('-')) {
      flags.push(t);
      if (PUSH_WITH_VALUE.has(t)) i++;
    } else pos.push(t);
  }
  const current = runGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const upstream = upstreamBranch(cwd);
  const short = (c: string): boolean => /^-[a-zA-Z0-9]+$/.test(c);
  const refspecs: Refspec[] = pos.slice(1).map(spec => {
    const force = spec.startsWith('+');
    const s = force ? spec.slice(1) : spec;
    const colon = s.indexOf(':');
    const src = colon >= 0 ? s.slice(0, colon) : s;
    let dst = colon >= 0 ? s.slice(colon + 1) : s;
    if (dst === 'HEAD' || dst === '@') dst = current ?? '';
    if (dst) dst = dst.replace(/^refs\/heads\//, '');
    return { spec, force, deletes: colon >= 0 && src === '', dst: dst || undefined };
  });
  return {
    flags,
    refspecs,
    current,
    upstream,
    force:
      refspecs.some(r => r.force) ||
      flags.some(
        f =>
          f === '--force' ||
          f.startsWith('--force-with-lease') ||
          f === '--force-if-includes' ||
          (short(f) && f.includes('f'))
      ),
    deletes:
      refspecs.some(r => r.deletes) || flags.some(f => f === '--delete' || (short(f) && f.includes('d'))),
    bulk: flags.some(f => f === '--all' || f === '--mirror' || f === '--prune' || f === '--branches'),
    // Without refspecs git pushes the current branch, or its upstream (push.default=upstream).
    targets: refspecs.length ? refspecs.map(r => r.dst ?? '') : [current, upstream].filter(isDefined),
    // The target repository: the first positional is the remote name or URL (undefined for a bare push).
    remote: pos.length ? pos[0] : undefined
  };
}

// Branch name (without remote) of the current branch's upstream, e.g. "vibe/issue-12-x".
function upstreamBranch(cwd: string | undefined): string | undefined {
  const ref = runGit(cwd, ['rev-parse', '--symbolic-full-name', '@{upstream}']);
  return ref?.replace(/^refs\/remotes\/[^/]+\//, '');
}

// Whether the configured remote named `name` exists (`git remote` lists its names). A remote configured
// in the user's checkout (e.g. a fork remote) is trusted; an arbitrary URL is not.
function remoteExists(cwd: string | undefined, name: string): boolean {
  return (
    runGit(cwd, ['remote'])
      ?.split('\n')
      .map(r => r.trim())
      .includes(name) ?? false
  );
}

// Short options of `git commit` that take a value: everything after them in a cluster is that value.
const COMMIT_SHORT_WITH_VALUE = 'mFcCtS';
const COMMIT_LONG_WITH_VALUE = new Set([
  '--message',
  '--file',
  '--reuse-message',
  '--reedit-message',
  '--template',
  '--author',
  '--date',
  '--fixup',
  '--squash',
  '--trailer',
  '--cleanup'
]);

function commitSkipsHooks(rest: string[]): boolean {
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--') break;
    if (COMMIT_LONG_WITH_VALUE.has(t)) {
      i++;
      continue;
    }
    if (/^-[a-zA-Z]/.test(t) && !t.startsWith('--')) {
      // Scan the whole short-option cluster, not just the first char: `-n` can appear anywhere in it
      // after a value-less flag (e.g. `-anm` = -a --no-verify -m). A value-taking flag is different:
      // git consumes the *rest of the token* as its value when it is not the entire token (verified:
      // `git commit -amn x` is parsed as `-a -m n` with `x` a pathspec, never as --no-verify), so
      // scanning must stop there — the remainder is the message, not flags. Otherwise any message
      // containing the letter n (`-m"fix the nit"`) would be a false positive.
      for (let j = 1; j < t.length; j++) {
        const ch = t[j];
        if (ch === 'n') return true;
        if (COMMIT_SHORT_WITH_VALUE.includes(ch)) {
          if (t.length === 2) i++; // value is the next separate token; never scan it as flags
          break; // attached value: the rest of this token is the value
        }
      }
    }
  }
  return false;
}

interface GhCall {
  sub: string | undefined;
  action: string | undefined;
  flags: string[];
}

function parseGh(args: string[]): GhCall {
  const pos: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '-R' || t === '--repo') {
      i++;
      continue;
    }
    if (t.startsWith('-')) flags.push(t);
    else pos.push(t);
  }
  return { sub: pos[0], action: pos[1], flags };
}

const API_WITH_VALUE = new Set([
  '-H',
  '--header',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--hostname',
  '--cache',
  '-p',
  '--preview'
]);

interface GhApiCall {
  method: string;
  endpoint: string;
  mutation: boolean;
  opaqueBody: boolean;
  fields: Record<string, string>;
  input: string | undefined;
}

function parseGhApi(args: string[]): GhApiCall {
  let method: string | undefined;
  let endpoint: string | undefined;
  let input: string | undefined;
  let hasBody = false;
  let opaqueBody = false;
  let mutation = false;
  const fields: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '-X' || t === '--method') method = args[++i];
    else if (t.startsWith('--method=')) method = t.slice(9);
    else if (/^-X./.test(t)) method = t.slice(2);
    else if (['-f', '-F', '--field', '--raw-field'].includes(t) || /^--(raw-)?field=/.test(t)) {
      const v = t.includes('=') && t.startsWith('--') ? t.slice(t.indexOf('=') + 1) : (args[++i] ?? '');
      hasBody = true;
      const eq = v.indexOf('=');
      if (eq > 0) fields[v.slice(0, eq)] = v.slice(eq + 1);
      if (/^query=/.test(v)) {
        if (/^query=@/.test(v)) opaqueBody = true;
        if (/\bmutation\b/.test(v)) mutation = true;
      }
    } else if (t === '--input') {
      hasBody = true;
      opaqueBody = true;
      input = args[++i];
    } else if (API_WITH_VALUE.has(t)) i++;
    else if (!t.startsWith('-') && endpoint === undefined) endpoint = t;
  }
  const resolvedEndpoint = (endpoint ?? '')
    .replace(/^\/+/, '')
    .replace(/\?.*$/, '')
    .replace('{owner}/{repo}', REPO);
  const resolvedMethod = (method ?? (hasBody ? 'POST' : 'GET')).toUpperCase();
  return { method: resolvedMethod, endpoint: resolvedEndpoint, mutation, opaqueBody, fields, input };
}

interface ReviewPayload {
  event?: unknown;
  body?: unknown;
  comments?: unknown;
}

// The reviewer's review must be a COMMENT review carrying the dev-loop marker. Returns a reason or null.
function reviewPayloadProblem(api: GhApiCall, cwd: string | undefined): string | null {
  let payload: ReviewPayload = api.fields;
  if (api.input !== undefined) {
    if (api.input === '-' || !cwd) return 'Pass the review JSON as a file (--input <file>), not on stdin.';
    try {
      payload = JSON.parse(readFileSync(resolve(cwd, api.input), 'utf8')) as ReviewPayload;
    } catch {
      return `Could not read the review JSON from ${api.input}.`;
    }
  }
  if (payload.event !== 'COMMENT') return 'Reviews must use "event": "COMMENT".';
  if (typeof payload.body !== 'string' || !payload.body.startsWith('<!-- dev-loop-review -->')) {
    return 'The review body must start with <!-- dev-loop-review -->.';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Rules

type Block = (reason: string) => void;

// Push-safety rules that every session (repo-wide and dev-loop agent alike) must enforce. Without
// this shared helper the git push handling in gitRules would return before the global checks apply,
// letting a dev-loop agent force-push or bulk-push.
function blockUnsafePush(push: PushCall, block: Block): void {
  if (push.force) block('Force-pushing is forbidden in this repository.');
  if (push.bulk) block('git push --all/--mirror/--prune/--branches is forbidden.');
  if (push.deletes) block('Deleting remote branches is forbidden.');
}

function globalRules(cmd: Command, block: Block): void {
  if (cmd.argv[0] !== 'git') return;
  const git = parseGit(cmd.argv.slice(1), cmd.cwd);
  if (git.rest.includes('--no-verify') || (git.sub === 'commit' && commitSkipsHooks(git.rest))) {
    block('Skipping git hooks (--no-verify) is forbidden.');
  }
  if (git.sub !== 'push') return;
  const push = parsePush(git.rest, git.cwd);
  blockUnsafePush(push, block);
  if (push.remote !== undefined && push.remote !== 'origin' && !remoteExists(git.cwd, push.remote)) {
    block(`Pushing to a remote other than origin (${push.remote}) is forbidden.`);
  }
  if (push.targets.includes(MAIN)) block(`Pushing to ${MAIN} is forbidden; open a pull request instead.`);
}

const GH_PR_READ = ['view', 'diff', 'list', 'checks', 'status', 'checkout'];
const GH_PR_EXTRA: Record<Role, string[]> = {
  implementer: ['create', 'edit'],
  reviewer: ['ready'],
  fixer: ['edit'],
  merger: ['ready']
};
const API_WRITES: Record<Role, RegExp[]> = {
  implementer: [],
  reviewer: [new RegExp(`^repos/${REPO}/pulls/\\d+/reviews$`)],
  fixer: [new RegExp(`^repos/${REPO}/pulls/\\d+/comments/\\d+/replies$`)],
  merger: []
};

function ghRules(role: Role, cmd: Command, block: Block): void {
  const gh = parseGh(cmd.argv.slice(1));
  const { sub, action, flags } = gh;
  const has = (...names: string[]): boolean =>
    flags.some(f => names.includes(f) || names.some(n => f.startsWith(`${n}=`)));
  const isDraft =
    flags.some(f => f === '--draft' || f === '-d' || f === '--draft=true') &&
    !flags.some(f => f === '--draft=false');

  if (sub === 'pr') {
    if (!GH_PR_READ.includes(action ?? '') && !GH_PR_EXTRA[role].includes(action ?? '')) {
      block(
        `The ${role} agent may not run "gh pr ${action ?? ''}". Merging and closing PRs is left to humans.`
      );
    } else if (action === 'create' && !isDraft) {
      block('PRs must be opened as drafts: add --draft.');
    } else if (action === 'edit' && has('--base', '-B')) {
      block('Changing the base branch of a PR is forbidden.');
    } else if (action === 'ready' && role === 'reviewer' && has('--undo')) {
      block('The reviewer may only mark a clean PR ready, not turn it back into a draft.');
    } else if (action === 'ready' && role === 'merger' && !has('--undo')) {
      block('The merger may only turn a PR back into a draft (gh pr ready --undo), never mark it ready.');
    }
  } else if (sub === 'issue') {
    const allowed = ['view', 'list', 'status', ...(role === 'implementer' ? ['comment', 'edit'] : [])];
    if (!allowed.includes(action ?? '')) block(`The ${role} agent may not run "gh issue ${action ?? ''}".`);
    else if (action === 'edit' && flags.some(f => f !== '--add-label' && !f.startsWith('--add-label='))) {
      block('gh issue edit is limited to --add-label.');
    }
  } else if (sub === 'api') {
    const api = parseGhApi(cmd.argv.slice(2));
    if (api.endpoint === 'graphql') {
      if (api.mutation || api.opaqueBody) block('GraphQL mutations are forbidden for dev-loop agents.');
    } else if (
      api.method !== 'GET' &&
      !(api.method === 'POST' && API_WRITES[role].some(re => re.test(api.endpoint)))
    ) {
      block(`The ${role} agent may not ${api.method} ${api.endpoint || 'that endpoint'}.`);
    } else if (role === 'reviewer' && api.method === 'POST') {
      const problem = reviewPayloadProblem(api, cmd.cwd);
      if (problem) block(problem);
    }
  } else if (sub === 'run') {
    if (!['view', 'list', 'watch'].includes(action ?? '')) {
      block(`The ${role} agent may not run "gh run ${action ?? ''}".`);
    }
  } else if (sub === 'label') {
    if (action !== 'list') block(`The ${role} agent may not run "gh label ${action ?? ''}".`);
  } else if (sub === 'auth') {
    if (action !== 'status') block(`The ${role} agent may not run "gh auth ${action ?? ''}".`);
  } else if (!['search', 'status', 'help', 'version', undefined].includes(sub)) {
    block(`The ${role} agent may not run "gh ${sub ?? ''}".`);
  }
}

const positionals = (rest: string[]): string[] => rest.filter(t => !t.startsWith('-'));

// The fixer integrates nothing but its own PR branch: `git merge|rebase origin/<upstream>` or
// `git pull [--no-rebase] origin <upstream>`. Anything else could bring in main (also via FETCH_HEAD,
// origin/HEAD, refs/remotes/origin/main, ...).
function fixerIntegratesOnlyOwnBranch(sub: string, rest: string[], cwd: string | undefined): boolean {
  const upstream = upstreamBranch(cwd);
  if (!upstream) return false;
  const pos = positionals(rest);
  // A pull must never rebase: the fixer only integrates its own PR branch with a real merge.
  if (sub === 'pull') {
    if (rest.some(f => f === '-r' || f === '--rebase' || /^--rebase=/.test(f) || f === '-p')) return false;
    return pos.length === 0 || (pos.length === 2 && pos[1] === upstream);
  }
  const own = new Set([`origin/${upstream}`, `refs/remotes/origin/${upstream}`, '@{u}', '@{upstream}']);
  return pos.every(t => own.has(t));
}

const MERGER_FORBIDDEN = ['rebase', 'cherry-pick', 'revert', 'am', 'reset', 'tag'];
// Merge flags that produce something other than a real merge commit (--squash/--ff-only/--rebase/-r).
// `--no-ff` is the desired, legitimate merge flag for the merger, so it is not forbidden.
const NON_MERGE_FLAGS = ['--squash', '--ff-only', '--rebase', '-r'];
// Merge strategy flags that discard or unilaterally favour one side's tree (-s ours, -X ours/theirs),
// which would silently drop the other branch's intent instead of resolving the conflict.
const STRATEGY_FLAGS = ['-s', '--strategy', '-X', '--strategy-option'];
const DROP_STRATEGY_WORDS = ['ours', 'theirs'];
// Config keys that would turn a pull/merge into a rebase, squash or fast-forward-only, or rewrite
// which ref gets pushed. Agents never need to set git config.
const UNSAFE_CONFIG =
  /^(pull\.|merge\.|branch\..*\.(rebase|merge|mergeOptions|remote)|remote\.|push\.|alias\.|rebase\.)/i;

function gitRules(role: Role, cmd: Command, block: Block): void {
  const git = parseGit(cmd.argv.slice(1), cmd.cwd);
  const { sub, rest } = git;

  if (git.config.some(c => UNSAFE_CONFIG.test(c))) {
    block('Overriding git config for pull/merge/push/remote/alias with -c is forbidden for dev-loop agents.');
  }
  // Reading config (`git config --get x`, `git config x`, `git config --list`) is fine; writing is not.
  // A write is either two+ positionals (`git config key value`) or a single config-key positional
  // followed by a `-`-prefixed value (`git config branch.main.mergeOptions --rebase`), which the
  // positional-only count below would otherwise let through as a "read".
  const configReads = ['--get', '--get-all', '--get-regexp', '--list', '-l'];
  if (sub === 'config') {
    const pos = positionals(rest);
    const reads = rest.some(t => configReads.includes(t));
    const twoPos = pos.length > 1;
    let lastDashFlag = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].startsWith('-') && !configReads.includes(rest[i])) lastDashFlag = i;
    }
    const keyThenDashValue =
      pos.length === 1 &&
      /^[a-z]+([-./][a-zA-Z0-9_./-]+)+$/.test(pos[0]) &&
      rest.indexOf(pos[0]) < lastDashFlag;
    if (!reads && (twoPos || keyThenDashValue)) {
      block('Changing git config is forbidden for dev-loop agents.');
    }
  }
  // Resetting onto another commit is how a branch silently picks up main (or drops commits).
  const resetTarget = sub === 'reset' ? positionals(rest).find(t => t !== 'HEAD') : undefined;
  if (
    resetTarget &&
    runGit(git.cwd, ['rev-parse', '-q', '--verify', `${resetTarget}^{commit}`]) !== undefined
  ) {
    block('git reset onto another commit is forbidden for dev-loop agents; add new commits instead.');
  }
  // Rewriting remotes would let an agent point origin elsewhere (or add a trusted remote) and then push
  // to an arbitrary repository, so the whole modifying surface of `git remote` is off-limits. Bare
  // `git remote` / `git remote -v` (listing) stays allowed.
  if (sub === 'remote') {
    const verb = positionals(rest)[0];
    if (['add', 'set-url', 'remove', 'rename'].includes(verb ?? '')) {
      block('Changing git remotes (git remote add/set-url/remove/rename) is forbidden for dev-loop agents.');
    }
  }

  if (sub === 'commit' && rest.includes('--amend')) block('Amending commits is forbidden; add a new commit.');
  if (sub === 'commit' && (rest.includes('--no-verify') || commitSkipsHooks(rest))) {
    block('Skipping git hooks (--no-verify) is forbidden.');
  }

  if (
    role === 'reviewer' &&
    ['commit', 'push', 'merge', 'rebase', 'pull', 'cherry-pick', 'revert', 'am', 'tag'].includes(sub ?? '')
  ) {
    block(`The reviewer never changes the branch: "git ${sub ?? ''}" is forbidden.`);
    return;
  }
  if (
    role === 'fixer' &&
    ['merge', 'pull'].includes(sub ?? '') &&
    !fixerIntegratesOnlyOwnBranch(sub ?? '', rest, git.cwd)
  ) {
    block(
      `The fixer only integrates its own PR branch (origin/<upstream>); ${MAIN} is merged by the merger agent.`
    );
  }
  if (role === 'fixer' && sub === 'rebase') {
    block('The fixer never rebases; merge the PR branch or leave it to the merger agent.');
  }
  if (role === 'merger') {
    if (MERGER_FORBIDDEN.includes(sub ?? '')) {
      block(`The merger only creates merge commits: "git ${sub ?? ''}" is forbidden.`);
    }
    if (
      (sub === 'merge' || sub === 'pull') &&
      rest.some(f => NON_MERGE_FLAGS.includes(f) || /^--rebase=/.test(f))
    ) {
      block('The merger only creates real merge commits: no --squash, --ff-only or --rebase.');
    }
    if (sub === 'merge' || sub === 'pull') {
      // `-s values` come as separate tokens (`git merge -s ours other`): the value token after a
      // strategy flag is the strategy to reject; long flags attach the value with `=` (`--strategy-option=theirs`);
      // and the short flags may be attached directly (`-Xours`, `-sours`) with no space.
      let dropping = false;
      for (let i = 0; i < rest.length; i++) {
        const t = rest[i];
        if (STRATEGY_FLAGS.includes(t)) {
          const v = rest[i + 1];
          if (DROP_STRATEGY_WORDS.includes(v ?? '')) dropping = true;
        } else if (new RegExp(`^(${STRATEGY_FLAGS.join('|')})=`).test(t)) {
          if (DROP_STRATEGY_WORDS.includes(t.slice(t.indexOf('=') + 1))) dropping = true;
        } else if (/^-[sX](ours|theirs)$/.test(t)) {
          dropping = true;
        }
      }
      if (dropping) {
        block('The merger must not use an ours/theirs strategy; resolve the conflict keeping both sides.');
      }
    }
    // A commit is fine while a merge is in progress, or as a follow-up fix on top of an unpushed merge.
    const merging = runGit(git.cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']) !== undefined;
    const unpushedMerge =
      Number(runGit(git.cwd, ['rev-list', '--merges', '--count', '@{upstream}..HEAD'])) > 0;
    if (sub === 'commit' && !merging && !unpushedMerge) {
      block('The merger only commits merges (or fixes on top of an unpushed merge).');
    }
  }

  if (sub !== 'push') return;
  const push = parsePush(rest, git.cwd);
  blockUnsafePush(push, block);
  if (push.remote !== undefined && push.remote !== 'origin' && !remoteExists(git.cwd, push.remote)) {
    block(`Pushing to a remote other than origin (${push.remote}) is forbidden.`);
  }
  if (!push.current) {
    block('Push from a checked-out branch, not from a detached HEAD.');
    return;
  }
  const foreign = push.targets.filter(t => t && t !== push.current && t !== push.upstream);
  if (foreign.length) {
    block(
      `Only the checked-out branch ${push.current} or its upstream may be pushed, not ${foreign.join(', ')}.`
    );
  }
  if (role === 'implementer' && !/^vibe\/issue-\d+(-|$)/.test(push.current)) {
    block(`The implementer pushes only vibe/issue-<N>-<slug> branches, not ${push.current}.`);
  }
}

// The reviewer runs the project as-is. It may only use these package-manager commands; everything else
// (install <pkg>, aliases like `isntall`/`it`/`un`, link, exec, dlx, ...) could change dependencies.
const REVIEWER_NPM = new Set([
  'ci',
  'test',
  't',
  'run',
  'run-script',
  'ls',
  'list',
  'view',
  'outdated',
  'audit'
]);
const REVIEWER_NPM_INSTALL = new Set(['install', 'i']); // only without package arguments

// npx `--package <pkg>` / `-p <pkg>` / `--package=<pkg>` can install and run a package the reviewer is not
// allowed to invoke (its install lifecycle scripts run locally). Explicitly naming the *allowlisted* binary
// itself (e.g. `--package=prettier`) is harmless, so only a package other than the allowlisted binary is
// smuggled in. The allowlisted binaries: prettier, eslint, jest, tsc. A `@version` suffix on either side
// is ignored (`prettier@3` is still prettier), but a scoped `@scope/name` never matches an allowlisted
// (unscoped) binary.
//
// Parsing mirrors npx's own (verified with npx 10): npx stops parsing its options at the first true
// positional — the command — and everything after it belongs to the command (so `npx -p typescript tsc
// -p tsconfig.json` passes the second -p to tsc). Crucially, a package name that is merely the VALUE of
// -p/--package is not the command: in `npx -p prettier --call "cmd"` npx runs the shell command. So the
// walker consumes option values, treats the first unconsumed positional as the bin, and rejects the
// shell-escape flags --call/--shell/-c anywhere in npx's own option region.
const NPX_BIN_ALLOWLIST = ['prettier', 'eslint', 'jest', 'tsc'];

const packageName = (spec: string): string => (spec.startsWith('@') ? spec : spec.split('@')[0]);

function reviewNpxPackage(args: string[]): boolean {
  let bin: string | undefined;
  let shellEscape = false;
  const packages: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!t.startsWith('-')) {
      bin = t;
      break; // the command: everything after it belongs to the binary, not npx
    }
    if (t === '--package' || t === '-p') {
      packages.push(args[++i] ?? '');
      continue;
    }
    if (t.startsWith('--package=') || t.startsWith('-p=')) {
      packages.push(t.slice(t.indexOf('=') + 1));
      continue;
    }
    if (/^-p.+/.test(t)) {
      packages.push(t.slice(2)); // attached short value (`-p<pkg>`), like `-p=...`
      continue;
    }
    // `--call`, `--shell` and `-c` make npx execute an arbitrary command string (potentially a
    // shell), which would bypass the allowlisted binary: reject them outright.
    if (t === '--call' || t === '--shell' || t === '-c') {
      shellEscape = true;
      i++; // the command string is the flag's value
      continue;
    }
    if (t.startsWith('--call=') || t.startsWith('--shell=') || /^-c./.test(t)) {
      shellEscape = true; // attached value (`--call=...`, `-c<cmd>`)
      continue;
    }
  }
  if (shellEscape) return false;
  if (bin === undefined) return false; // no command: package-install or shell mode, never needed here
  const binName = packageName(bin);
  if (!NPX_BIN_ALLOWLIST.includes(binName)) return false;
  return packages.every(pkg => packageName(pkg) === binName);
}

function reviewerPackageRules(name: string, args: string[], block: Block): void {
  if (name === 'npx' || name === 'corepack' || name === 'pnpx' || name === 'bunx') {
    if (name === 'npx' && reviewNpxPackage(args)) return;
    block(`The reviewer may not run "${name}" except "npx prettier|eslint|jest|tsc".`);
    return;
  }
  if (name === 'yarn' || name === 'pnpm' || name === 'bun') {
    block(`This project uses npm; the reviewer may not run "${name}".`);
    return;
  }
  // npm
  const verb = args.find(a => !a.startsWith('-'));
  if (verb === undefined || REVIEWER_NPM.has(verb)) return;
  if (REVIEWER_NPM_INSTALL.has(verb) && args.filter(a => !a.startsWith('-')).length === 1) return;
  block(`The reviewer may not run "npm ${verb}"; use npm ci, npm test, npm run <script>.`);
}

function roleRules(role: Role, cmd: Command, block: Block): void {
  const [name, ...args] = cmd.argv;
  if (name === 'gh') ghRules(role, cmd, block);
  else if (name === 'git') gitRules(role, cmd, block);
  else if (
    role === 'reviewer' &&
    ['npm', 'npx', 'yarn', 'pnpm', 'bun', 'corepack', 'pnpx', 'bunx'].includes(name)
  ) {
    reviewerPackageRules(name, args, block);
  }
}

// Bodies of every `$(...)` / backtick command substitution in the raw command string. Used by the
// dev-loop agent path to check the substituted *content* through the same rules engine: a benign
// substitution (`$(date +%s)`, used in generated branch names) passes, one that smuggles a blocked
// command (`$(git push origin main)`) is caught. Nested substitutions shrink strictly at each level,
// so the recursion in check() terminates.
function substitutionBodies(command: string): string[] {
  const bodies: string[] = [];
  const stack: { marker: string; start: number }[] = [];
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '$' && command[i + 1] === '(') {
      stack.push({ marker: ')', start: i + 2 });
      i++;
    } else if (c === '`') {
      const open = stack.pop();
      if (open && open.marker === '`') bodies.push(command.slice(open.start, i));
      else stack.push({ marker: '`', start: i + 1 });
    } else if (c === ')' && stack.length > 0 && stack[stack.length - 1].marker === ')') {
      const open = stack.pop();
      if (open) bodies.push(command.slice(open.start, i));
    }
  }
  return bodies;
}

export interface CheckOptions {
  role?: Role;
  cwd?: string;
}

// Returns every reason the command is blocked (empty array = allowed). Without a role only the
// repo-wide rules apply. Throws for an unknown role: the plugin derives roles from the session's
// agent ID, so an unknown role is a wiring bug and must fail loudly (and closed), not silently.
export function check(command: string, opts: CheckOptions = {}): string[] {
  const { role, cwd } = opts;
  if (role !== undefined && !ROLES.includes(role)) {
    throw new Error(`guard.ts: unknown role "${String(role)}" (expected ${ROLES.join(', ')}).`);
  }
  const reasons: string[] = [];
  const block: Block = reason => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  // Repo-wide (non-agent) check: reject command substitution outright. Backticks / `$(` can smuggle a
  // blocked command past tokenization (e.g. `` echo `git push origin main` ``). Dev-loop agent sessions
  // keep their documented workflow (`$(date +%s)` inside branch names), so there the substitution
  // *bodies* are extracted and checked through the same rules engine: `$(date +%s)` passes, while
  // `$(git push origin main)` (or backticks smuggling any blocked command) is blocked.
  if (!role && /`|\$\(/.test(command)) {
    block('Command substitution (backticks or $()) is forbidden.');
  }
  if (role) {
    for (const body of substitutionBodies(command)) {
      for (const reason of check(body, { role, cwd })) {
        block(reason);
      }
    }
  }
  for (const cmd of commands(command, cwd)) {
    if (role) roleRules(role, cmd, block);
    else globalRules(cmd, block);
  }
  return reasons;
}
