import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const root = resolve(__dirname, '../..');
const runner = readFileSync(join(root, '.github/dev-loop/scripts/opencode-runner.sh'), 'utf8');
let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'dev-loop-runner-'));
  mkdirSync(join(sandbox, 'out'));
  mkdirSync(join(sandbox, 'bin'));
  writeFileSync(join(sandbox, 'prompt'), 'a prompt\nwith multiple lines\n');
  writeFileSync(join(sandbox, 'output'), '');
  writeFileSync(
    join(sandbox, 'bin/opencode'),
    `#!/usr/bin/env bash
printf '%s\n' "$@" > "$MOCK_ARGS"
printf '%s\n' "$$" > "$MOCK_PID"
if [ "${'${MOCK_REPLACE:-}'}" = 1 ]; then printf 'exit 42\n' > "$MOCK_SNAPSHOT"; fi
cat "$MOCK_STREAM"
echo 'mock stderr' >&2
if [ "${'${MOCK_SLEEP:-}'}" = 1 ]; then exec sleep 5; fi
exit "${'${MOCK_RC:-0}'}"
`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(sandbox, 'bin/pkill'),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$MOCK_KILLS"\nif [ "${MOCK_KILL_LIVE:-}" = 1 ]; then kill -TERM "$(cat "$MOCK_PID")"; fi\n',
    { mode: 0o755 }
  );
});

afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

const event = (value: unknown) => `${JSON.stringify(value)}\n`;
const tool = (status: string, exit?: number) =>
  event({ type: 'tool_use', part: { state: { status, metadata: { metadata: { exit } } } } });
const step = () => event({ type: 'step_start' });
const tokens = (input: number, output: number, write: number, read: number) =>
  event({ type: 'step_finish', part: { tokens: { input, output, cache: { write, read } } } });

const run = (stream: string, overrides: Record<string, string> = {}) => {
  writeFileSync(join(sandbox, 'stream'), stream);
  writeFileSync(join(sandbox, 'snapshot'), runner);
  const env = {
    ...process.env,
    PATH: `${join(sandbox, 'bin')}:${process.env['PATH']}`,
    HOME: sandbox,
    OPENCODE_CONFIG_DIR: join(sandbox, 'config'),
    TAVILY_API_KEY: '',
    GITHUB_OUTPUT: join(sandbox, 'output'),
    MAX_TURNS: '100',
    MAX_TOKENS: '1000',
    MAX_DENIED_STREAK: '3',
    TIME_LIMIT_SEC: '5',
    MOCK_ARGS: join(sandbox, 'args'),
    MOCK_STREAM: join(sandbox, 'stream'),
    MOCK_KILLS: join(sandbox, 'kills'),
    MOCK_PID: join(sandbox, 'pid'),
    MOCK_SNAPSHOT: join(sandbox, 'snapshot'),
    ...overrides
  };
  // The workflow loads the snapshot into bash -c before opencode can replace it.
  const command = 'runner="$(cat "$MOCK_SNAPSHOT")"\nbash -eo pipefail -c "$runner" -- run prompt';
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', command], {
    cwd: sandbox,
    env,
    encoding: 'utf8',
    timeout: 10000
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return { result, output: readFileSync(join(sandbox, 'output'), 'utf8') };
};

test('forwards prompt, stream and stderr and preserves a nonzero agent exit', () => {
  const stream = step() + event({ type: 'text', part: { text: 'hello' } });
  const { result, output } = run(stream, { MOCK_RC: '7', TAVILY_API_KEY: 'configured' });
  expect(output).toBe('rc=7\n');
  expect(readFileSync(join(sandbox, 'out/stream.ndjson'), 'utf8')).toBe(stream);
  expect(readFileSync(join(sandbox, 'out/opencode.stderr'), 'utf8')).toBe('mock stderr\n');
  expect(result.stdout).toContain('mock stderr');
  expect(readFileSync(join(sandbox, 'config/opencode.jsonc'), 'utf8')).toBe(
    '{"websearch": {"provider": "tavily"}}\n'
  );
  expect(readFileSync(join(sandbox, 'args'), 'utf8')).toBe(
    'run\n--standalone\n--format\njson\n--auto\n--model\nmistral/zai-glm-5-3\na prompt\nwith multiple lines\n'
  );
});

test('success resets a failed-tool streak; pending calls and other events do not', () => {
  const stream =
    tool('failed') +
    tool('completed', 1) +
    tool('completed', 0) +
    tool('failed') +
    tool('running') +
    event({ type: 'text' }) +
    tool('completed', 2);
  const { result, output } = run(stream);
  expect(output).toBe('rc=0\n');
  expect(result.stdout.match(/failed tool call streak = 1/g)).toHaveLength(2);
  expect(result.stdout.match(/failed tool call streak = 2/g)).toHaveLength(2);
  expect(result.stdout).not.toContain('killing opencode');
});

test.each([
  [
    'failed tools',
    tool('failed') + tool('completed', 2) + tool('failed'),
    {},
    '3 consecutive failed tool calls'
  ],
  ['steps', step() + step(), { MAX_TURNS: '2' }, 'step limit 2'],
  ['weighted tokens', tokens(5, 2, 1, 10) + tokens(0, 0, 0, 10), { MAX_TOKENS: '10' }, 'token limit 10']
])('watchdog stops on %s and emits the exact outputs', (_name, stream, limits, message) => {
  const { result, output } = run(stream, limits);
  expect(output).toBe('rc=99\nstopped_by_watchdog=true\n');
  expect(result.stdout).toContain(message);
  expect(readFileSync(join(sandbox, 'kills'), 'utf8')).toBe('-TERM -f opencode run\n');
  expect(readFileSync(join(sandbox, 'out/stream.ndjson'), 'utf8')).toBe(stream);
});

test('timeout remains rc=124, without the watchdog flag', () => {
  expect(run('', { TIME_LIMIT_SEC: '0.2', MOCK_SLEEP: '1' }).output).toBe('rc=124\n');
});

test('watchdog interrupts a live stream before the timeout', () => {
  const { output } = run(step().repeat(1000), {
    MAX_TURNS: '1',
    TIME_LIMIT_SEC: '3',
    MOCK_SLEEP: '1',
    MOCK_KILL_LIVE: '1'
  });
  expect(output).toBe('rc=99\nstopped_by_watchdog=true\n');
});

test('a snapshot replaced by the agent cannot replace the running watchdog', () => {
  const { output } = run(step(), { MOCK_REPLACE: '1', MAX_TURNS: '1' });
  expect(readFileSync(join(sandbox, 'snapshot'), 'utf8')).toBe('exit 42\n');
  expect(output).toBe('rc=99\nstopped_by_watchdog=true\n');
});

test('a missing snapshot fails before starting the agent', () => {
  const result = spawnSync(
    'bash',
    [
      '-eo',
      'pipefail',
      '-c',
      'runner="$(cat "$MOCK_SNAPSHOT")"\nbash -eo pipefail -c "$runner" -- run prompt'
    ],
    { cwd: sandbox, env: { ...process.env, MOCK_SNAPSHOT: join(sandbox, 'missing') }, encoding: 'utf8' }
  );
  expect(result.status).not.toBe(0);
  expect(readFileSync(join(sandbox, 'output'), 'utf8')).toBe('');
});

test('installer uses the pinned version and fails on a mismatched binary', () => {
  writeFileSync(join(sandbox, 'bin/curl'), '#!/usr/bin/env bash\nprintf "exit 0\\n"\n', { mode: 0o755 });
  writeFileSync(join(sandbox, 'bin/opencode'), '#!/usr/bin/env bash\necho "opencode 2.0.26"\n', {
    mode: 0o755
  });
  const env = {
    ...process.env,
    HOME: sandbox,
    PATH: `${join(sandbox, 'bin')}:${process.env['PATH']}`,
    OPENCODE_VERSION: '2.0.26'
  };
  expect(
    execFileSync('bash', ['-eo', 'pipefail', '-c', runner, '--', 'install'], {
      cwd: sandbox,
      env,
      encoding: 'utf8'
    })
  ).toContain('2.0.26');
  expect(
    spawnSync('bash', ['-eo', 'pipefail', '-c', runner, '--', 'install'], {
      cwd: sandbox,
      env: { ...env, OPENCODE_VERSION: 'wrong' }
    }).status
  ).toBe(1);
});

test.each([
  ['implement', 'implementer', 'secrets.DEV_LOOP_TOKEN'],
  ['review', 'reviewer', 'secrets.DEV_LOOP_TOKEN_READONLY || secrets.DEV_LOOP_TOKEN'],
  ['fix', 'fixer', 'secrets.DEV_LOOP_TOKEN']
])(
  '%s workflow fetches trusted main and calls the shared runner with its role credentials',
  (workflow, role, token) => {
    const yaml = readFileSync(join(root, `.github/workflows/dev-loop-${workflow}.yml`), 'utf8');
    const fetch = yaml.indexOf('- name: Fetch trusted opencode runner');
    const install = yaml.indexOf('- name: Install opencode');
    const agent = yaml.indexOf(`- name: Run opencode ${role}`);
    const artifact = yaml.indexOf('- name: Upload opencode output artifact');
    expect(fetch).toBeGreaterThan(yaml.indexOf('run: npm ci'));
    expect(install).toBeGreaterThan(fetch);
    expect(agent).toBeGreaterThan(install);
    expect(artifact).toBeGreaterThan(agent);
    expect(yaml.slice(fetch, install)).toContain('opencode-runner.sh?ref=main');
    expect(yaml.slice(install, agent)).toContain(
      'runner="$(cat "$RUNNER_TEMP/dev-loop-opencode-runner.sh")"'
    );
    expect(yaml.slice(install, agent)).toContain('bash -eo pipefail -c "$runner" -- install');
    const agentStep = yaml.slice(agent, artifact);
    expect(agentStep).toContain(`GH_TOKEN: \${{ ${token} }}`);
    expect(agentStep).toContain('runner="$(cat "$RUNNER_TEMP/dev-loop-opencode-runner.sh")"');
    expect(agentStep).toContain(`bash -eo pipefail -c "$runner" -- run out/${role}.rendered.md`);
    expect(yaml.slice(artifact)).toContain(`out/${role}.rendered.md`);
  }
);
