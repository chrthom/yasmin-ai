import { config, validateEnv } from '../config';

const REQUIRED_GETTER_KEYS = [
  ['mistral.apiKey', 'MISTRAL_API_KEY'],
  ['mistral.agentId', 'AGENT_ID_CONVERSATION'],
  ['mistral.libraryId', 'MISTRAL_LIBRARY_ID'],
  ['mistral.nightlyAgentId', 'AGENT_ID_NIGHTLY'],
  ['synology.tokens.bot', 'CHAT_TOKEN_BOT'],
  ['synology.tokens.slash', 'CHAT_TOKEN_SLASH'],
  ['synology.tokens.group', 'CHAT_TOKEN_GROUP']
] as const;

const get = (path: string): unknown =>
  path
    .split('.')
    .reduce<
      Record<string, unknown>
    >((obj, key) => obj[key] as Record<string, unknown>, config as unknown as Record<string, unknown>);

describe('config required getters', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [, key] of REQUIRED_GETTER_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test.each(REQUIRED_GETTER_KEYS)('throws on missing %s (%s)', (path, key) => {
    expect(() => get(path)).toThrow(`Missing required environment variable: ${key}`);
  });

  test('optional values fall back instead of throwing', () => {
    expect(config.mistral.summarizerAgentId).toEqual('');
  });
});

describe('validateEnv', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const keys = [...REQUIRED_GETTER_KEYS.map(([, key]) => key), 'DB_PASSWORD', 'USE_REAL_DB'];

  beforeEach(() => {
    for (const key of keys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  const setAll = (value: string): void => {
    for (const [, key] of REQUIRED_GETTER_KEYS) {
      process.env[key] = value;
    }
  };

  it('exits listing every missing required variable', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      validateEnv();
      expect(exit).toHaveBeenCalledWith(1);
      for (const [, key] of REQUIRED_GETTER_KEYS) {
        expect(error).toHaveBeenCalledWith(`ERROR: Missing required environment variable: ${key}`);
      }
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it('warns when CHAT_BOT_USER_ID is unset or non-numeric', () => {
    setAll('set');
    process.env['CHAT_BOT_USER_ID'] = 'not-a-number';
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      validateEnv();
      expect(warn).toHaveBeenCalledWith(
        "WARNING: CHAT_BOT_USER_ID is not set; the bot's own replies cannot be excluded from group channel history."
      );
      process.env['CHAT_BOT_USER_ID'] = '42';
      warn.mockClear();
      validateEnv();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      delete process.env['CHAT_BOT_USER_ID'];
      exit.mockRestore();
      warn.mockRestore();
    }
  });

  it('does not require DB_PASSWORD by default', () => {
    setAll('set');
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      validateEnv();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it.each([
    ['requireDb option', () => validateEnv({ requireDb: true })],
    [
      'USE_REAL_DB=true',
      () => {
        process.env['USE_REAL_DB'] = 'true';
        validateEnv();
      }
    ]
  ] as const)('requires DB_PASSWORD via %s', (_name, run) => {
    setAll('set');
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      run();
      expect(exit).toHaveBeenCalledWith(1);
      expect(error).toHaveBeenCalledWith('ERROR: Missing required environment variable: DB_PASSWORD');
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});
