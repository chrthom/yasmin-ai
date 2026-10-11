#!/usr/bin/env node
// PreToolUse hook for the Bash tool: blocks git/gh commands by reading the hook input from stdin and
// exiting with code 2 (the reason on stderr is shown to the model).
//
//   node guard-bash.mjs           repo-wide rules (wired in .openclaude/settings.json, every session)
//   node guard-bash.mjs <role>    dev-loop agent rules (wired in each .openclaude/agents/<role>.md)
//
// This is a guardrail against mistakes, not a sandbox: it parses the command text, so deliberate
// obfuscation (command substitution, aliases, scripts) is not caught. Branch protection on GitHub is
// the real enforcement for main.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = 'chrthom/yasmin-ai';
const MAIN = 'main';
const ROLES = ['implementer', 'reviewer', 'fixer', 'merger'];

// ---------------------------------------------------------------------------------------------------
// Shell parsing (good enough for the commands agents write; not a full shell grammar)

function splitCommands(src) {
  const segments = [];
  let tokens = [];
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

function stripRedirects(tokens) {
  const out = [];
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
const base = t => t.split('/').pop();

// Yields { argv, cwd } for every simple command, following `cd` and descending into `sh -c` / `eval`.
function* commands(src, cwd) {
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

function runGit(cwd, args) {
  if (!cwd) return undefined;
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

const GIT_GLOBAL_WITH_VALUE = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);

function parseGit(args, cwd) {
  let i = 0;
  const config = [];
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

function parsePush(rest, cwd) {
  const flags = [];
  const pos = [];
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
  const short = c => /^-[a-zA-Z0-9]+$/.test(c);
  const refspecs = pos.slice(1).map(spec => {
    const force = spec.startsWith('+');
    const s = force ? spec.slice(1) : spec;
    const colon = s.indexOf(':');
    const src = colon >= 0 ? s.slice(0, colon) : s;
    let dst = colon >= 0 ? s.slice(colon + 1) : s;
    if (dst === 'HEAD' || dst === '@') dst = current;
    if (dst) dst = dst.replace(/^refs\/heads\//, '');
    return { spec, force, deletes: colon >= 0 && src === '', dst };
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
    targets: refspecs.length ? refspecs.map(r => r.dst) : [current, upstream].filter(Boolean),
    // The target repository: the first positional is the remote name or URL (undefined for a bare push).
    remote: pos.length ? pos[0] : undefined
  };
}

// Branch name (without remote) of the current branch's upstream, e.g. "vibe/issue-12-x".
function upstreamBranch(cwd) {
  const ref = runGit(cwd, ['rev-parse', '--symbolic-full-name', '@{upstream}']);
  return ref?.replace(/^refs\/remotes\/[^/]+\//, '');
}

// Whether the configured remote named `name` exists (`git remote` lists its names). A remote configured
// in the user's checkout (e.g. a fork remote) is trusted; an arbitrary URL is not.
function remoteExists(cwd, name) {
  return runGit(cwd, ['remote'])
    ?.split('\n')
    .map(r => r.trim())
    .includes(name);
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

function commitSkipsHooks(rest) {
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--') break;
    if (COMMIT_LONG_WITH_VALUE.has(t)) {
      i++;
      continue;
    }
    if (/^-[a-zA-Z]/.test(t) && !t.startsWith('--')) {
      // Scan the whole short-option cluster, not just the first char: `-n` can appear anywhere in it
      // (e.g. `-amn`, `-anm`). A value-taking flag consumes the *rest of the token* as its value when
      // it is not the entire token, so we keep scanning for `n` instead of breaking out.
      for (let j = 1; j < t.length; j++) {
        const ch = t[j];
        if (ch === 'n') return true;
        if (COMMIT_SHORT_WITH_VALUE.includes(ch)) {
          if (t.length === 2) {
            i++; // value is the next separate token
            break;
          }
          // attached value in this same token; keep scanning the remainder of the cluster
        }
      }
    }
  }
  return false;
}

function parseGh(args) {
  const pos = [];
  const flags = [];
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

function parseGhApi(args) {
  let method;
  let endpoint;
  let input;
  let hasBody = false;
  let opaqueBody = false;
  let mutation = false;
  const fields = {};
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
  endpoint = (endpoint ?? '').replace(/^\/+/, '').replace(/\?.*$/, '').replace('{owner}/{repo}', REPO);
  const resolvedMethod = (method ?? (hasBody ? 'POST' : 'GET')).toUpperCase();
  return { method: resolvedMethod, endpoint, mutation, opaqueBody, fields, input };
}

// The reviewer's review must be a COMMENT review carrying the dev-loop marker. Returns a reason or null.
function reviewPayloadProblem(api, cwd) {
  let payload = api.fields;
  if (api.input !== undefined) {
    if (api.input === '-' || !cwd) return 'Pass the review JSON as a file (--input <file>), not on stdin.';
    try {
      payload = JSON.parse(readFileSync(resolve(cwd, api.input), 'utf8'));
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

// Push-safety rules that every session (repo-wide and dev-loop agent alike) must enforce. Without
// this shared helper the git push handling in gitRules would return before the global checks apply,
// letting a dev-loop agent force-push or bulk-push.
function blockUnsafePush(push, block) {
  if (push.force) block('Force-pushing is forbidden in this repository.');
  if (push.bulk) block('git push --all/--mirror/--prune/--branches is forbidden.');
  if (push.deletes) block('Deleting remote branches is forbidden.');
}

function globalRules({ argv, cwd }, block) {
  if (argv[0] !== 'git') return;
  const git = parseGit(argv.slice(1), cwd);
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
const GH_PR_EXTRA = {
  implementer: ['create', 'edit'],
  reviewer: ['ready'],
  fixer: ['edit'],
  merger: ['ready']
};
const API_WRITES = {
  implementer: [],
  reviewer: [new RegExp(`^repos/${REPO}/pulls/\\d+/reviews$`)],
  fixer: [new RegExp(`^repos/${REPO}/pulls/\\d+/comments/\\d+/replies$`)],
  merger: []
};

function ghRules(role, { argv, cwd }, block) {
  const gh = parseGh(argv.slice(1));
  const { sub, action, flags } = gh;
  const has = (...names) => flags.some(f => names.includes(f) || names.some(n => f.startsWith(`${n}=`)));
  const isDraft =
    flags.some(f => f === '--draft' || f === '-d' || f === '--draft=true') &&
    !flags.some(f => f === '--draft=false');

  if (sub === 'pr') {
    if (!GH_PR_READ.includes(action) && !GH_PR_EXTRA[role].includes(action)) {
      block(`The ${role} agent may not run "gh pr ${action}". Merging and closing PRs is left to humans.`);
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
    if (!allowed.includes(action)) block(`The ${role} agent may not run "gh issue ${action}".`);
    else if (action === 'edit' && flags.some(f => f !== '--add-label' && !f.startsWith('--add-label='))) {
      block('gh issue edit is limited to --add-label.');
    }
  } else if (sub === 'api') {
    const api = parseGhApi(argv.slice(2));
    if (api.endpoint === 'graphql') {
      if (api.mutation || api.opaqueBody) block('GraphQL mutations are forbidden for dev-loop agents.');
    } else if (
      api.method !== 'GET' &&
      !(api.method === 'POST' && API_WRITES[role].some(re => re.test(api.endpoint)))
    ) {
      block(`The ${role} agent may not ${api.method} ${api.endpoint || 'that endpoint'}.`);
    } else if (role === 'reviewer' && api.method === 'POST') {
      const problem = reviewPayloadProblem(api, cwd);
      if (problem) block(problem);
    }
  } else if (sub === 'run') {
    if (!['view', 'list', 'watch'].includes(action))
      block(`The ${role} agent may not run "gh run ${action}".`);
  } else if (sub === 'label') {
    if (action !== 'list') block(`The ${role} agent may not run "gh label ${action}".`);
  } else if (sub === 'auth') {
    if (action !== 'status') block(`The ${role} agent may not run "gh auth ${action}".`);
  } else if (!['search', 'status', 'help', 'version', undefined].includes(sub)) {
    block(`The ${role} agent may not run "gh ${sub}".`);
  }
}

const positionals = rest => rest.filter(t => !t.startsWith('-'));

// The fixer integrates nothing but its own PR branch: `git merge|rebase origin/<upstream>` or
// `git pull [--no-rebase] origin <upstream>`. Anything else could bring in main (also via FETCH_HEAD,
// origin/HEAD, refs/remotes/origin/main, ...).
function fixerIntegratesOnlyOwnBranch(sub, rest, cwd) {
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

function gitRules(role, cmd, block) {
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
    const keyThenDashValue =
      pos.length === 1 &&
      /^[a-z]+([-./][a-zA-Z0-9_./-]+)+$/.test(pos[0]) &&
      rest.indexOf(pos[0]) < rest.findLastIndex(t => t.startsWith('-') && !configReads.includes(t));
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

  if (sub === 'commit' && rest.includes('--amend')) block('Amending commits is forbidden; add a new commit.');
  if (sub === 'commit' && (rest.includes('--no-verify') || commitSkipsHooks(rest))) {
    block('Skipping git hooks (--no-verify) is forbidden.');
  }

  if (
    role === 'reviewer' &&
    ['commit', 'push', 'merge', 'rebase', 'pull', 'cherry-pick', 'revert', 'am', 'tag'].includes(sub)
  ) {
    block(`The reviewer never changes the branch: "git ${sub}" is forbidden.`);
    return;
  }
  if (
    role === 'fixer' &&
    ['merge', 'pull'].includes(sub) &&
    !fixerIntegratesOnlyOwnBranch(sub, rest, git.cwd)
  ) {
    block(
      `The fixer only integrates its own PR branch (origin/<upstream>); ${MAIN} is merged by the merger agent.`
    );
  }
  if (role === 'fixer' && sub === 'rebase') {
    block('The fixer never rebases; merge the PR branch or leave it to the merger agent.');
  }
  if (role === 'merger') {
    if (MERGER_FORBIDDEN.includes(sub))
      block(`The merger only creates merge commits: "git ${sub}" is forbidden.`);
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
// smuggled in. The allowlisted binaries: prettier, eslint, jest, tsc.
const NPX_BIN_ALLOWLIST = ['prettier', 'eslint', 'jest', 'tsc'];
function reviewNpxPackage(args) {
  const bin = args.find(a => !a.startsWith('-'));
  if (!NPX_BIN_ALLOWLIST.includes(bin)) return false;
  // `--call`, `--shell` and `-c` make npx execute an arbitrary command string (potentially a shell),
  // which would bypass the allowlisted binary: reject them outright.
  if (
    args.some(
      a => ['--call', '--shell', '-c'].includes(a) || a.startsWith('--call=') || a.startsWith('--shell=')
    )
  ) {
    return false;
  }
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    let pkg;
    if (t === '--package' || t === '-p') pkg = args[i + 1];
    else if (t.startsWith('--package=')) pkg = t.slice('--package='.length);
    else if (t.startsWith('-p=')) pkg = t.slice(3);
    if (pkg !== undefined && pkg !== bin) return false;
  }
  return true;
}
function reviewerPackageRules(name, args, block) {
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

function roleRules(role, cmd, block) {
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
function substitutionBodies(command) {
  const bodies = [];
  const stack = [];
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '$' && command[i + 1] === '(') {
      stack.push({ marker: ')', start: i + 2 });
      i++;
    } else if (c === '`') {
      if (stack.length && stack[stack.length - 1].marker === '`') {
        const open = stack.pop();
        bodies.push(command.slice(open.start, i));
      } else {
        stack.push({ marker: '`', start: i + 1 });
      }
    } else if (c === ')' && stack.length && stack[stack.length - 1].marker === ')') {
      const open = stack.pop();
      bodies.push(command.slice(open.start, i));
    }
  }
  return bodies;
}

function check(command, { role, cwd } = {}) {
  const reasons = [];
  const block = reason => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  // Repo-wide (non-agent) hook: reject command substitution outright. Backticks / `$(` can smuggle a
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

// ---------------------------------------------------------------------------------------------------

const role = process.argv[2];
if (role !== undefined && !ROLES.includes(role)) {
  process.stderr.write(`guard-bash.mjs: unknown role "${role}" (expected ${ROLES.join(', ')}).`);
  process.exit(2);
}
let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // not a hook invocation we understand; the harness always sends JSON
}
const command = input?.tool_input?.command;
if (input?.tool_name !== 'Bash' || typeof command !== 'string') process.exit(0);
const reasons = check(command, { role, cwd: input.cwd || process.cwd() });
if (reasons.length) {
  process.stderr.write(
    `Blocked by .openclaude/hooks/guard-bash.mjs${role ? ` (${role} rules)` : ''}: ${reasons.join(' ')}`
  );
  process.exit(2);
}
