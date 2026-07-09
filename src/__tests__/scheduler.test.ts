jest.mock('../config', () => ({
  config: {
    nightly: {
      tz: 'Europe/Berlin',
      maxRetries: 3,
      lockStaleMs: 1000,
      maxIterations: 15,
      archiveKeepVersions: 10,
      eagerMaxChars: 2000
    }
  }
}));

jest.mock('../nightly/pipeline', () => ({
  LockHeldError: class LockHeldError extends Error {},
  runNightlyPipeline: jest.fn()
}));

import { config } from '../config';
import { nextRunAt, startNightlyScheduler, stopNightlyScheduler } from '../nightly/scheduler';

describe('nextRunAt', () => {
  it('schedules later today (UTC) when the target time has not yet passed', () => {
    const now = new Date('2026-07-09T01:00:00Z');
    const result = nextRunAt(now, 'UTC', 3, 0);
    expect(result.toISOString()).toBe('2026-07-09T03:00:00.000Z');
  });

  it('rolls over to tomorrow (UTC) when the target time already passed today', () => {
    const now = new Date('2026-07-09T05:00:00Z');
    const result = nextRunAt(now, 'UTC', 3, 0);
    expect(result.toISOString()).toBe('2026-07-10T03:00:00.000Z');
  });

  it('rolls over exactly at the target instant, not on it', () => {
    const now = new Date('2026-07-09T03:00:00Z');
    const result = nextRunAt(now, 'UTC', 3, 0);
    expect(result.toISOString()).toBe('2026-07-10T03:00:00.000Z');
  });

  it('accounts for a positive UTC offset (Europe/Berlin, CEST = UTC+2, in July)', () => {
    // 03:00 local in Berlin during summer (UTC+2) is 01:00 UTC.
    const now = new Date('2026-07-09T00:00:00Z');
    const result = nextRunAt(now, 'Europe/Berlin', 3, 0);
    expect(result.toISOString()).toBe('2026-07-09T01:00:00.000Z');
  });

  it('accounts for standard time (Europe/Berlin, CET = UTC+1, in January)', () => {
    // 03:00 local in Berlin during winter (UTC+1) is 02:00 UTC.
    const now = new Date('2026-01-09T00:00:00Z');
    const result = nextRunAt(now, 'Europe/Berlin', 3, 0);
    expect(result.toISOString()).toBe('2026-01-09T02:00:00.000Z');
  });
});

describe('startNightlyScheduler', () => {
  afterEach(() => {
    stopNightlyScheduler();
    jest.useRealTimers();
  });

  it('arms exactly one timer, and ignores a second call while already armed', () => {
    jest.useFakeTimers();

    startNightlyScheduler();
    expect(jest.getTimerCount()).toBe(1);

    startNightlyScheduler();
    expect(jest.getTimerCount()).toBe(1);
  });

  it('falls back to a retry timer instead of throwing if computing the next run time fails', () => {
    jest.useFakeTimers();
    const originalTz = config.nightly.tz;
    (config.nightly as { tz: string }).tz = 'Not/ARealTimeZone';

    try {
      expect(() => startNightlyScheduler()).not.toThrow();
      expect(jest.getTimerCount()).toBe(1);
    } finally {
      (config.nightly as { tz: string }).tz = originalTz;
    }
  });
});
