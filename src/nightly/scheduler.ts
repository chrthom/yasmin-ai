import { config } from '../config';
import { LockHeldError, runNightlyPipeline } from './pipeline';

const NIGHTLY_HOUR = 23;
const NIGHTLY_MINUTE = 0;

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getDateParts(date: Date, timeZone: string): DateParts {
  const found = new Map<string, string>();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  for (const part of formatter.formatToParts(date)) {
    found.set(part.type, part.value);
  }

  return {
    year: Number(found.get('year')),
    month: Number(found.get('month')),
    day: Number(found.get('day')),
    hour: Number(found.get('hour')),
    minute: Number(found.get('minute')),
    second: Number(found.get('second'))
  };
}

/**
 * Returns how far ahead of UTC (in ms) timeZone's wall clock is at the given instant -- e.g. +2h for
 * Europe/Berlin during CEST. Used to translate a target wall-clock time into a real UTC instant without
 * pulling in a timezone library.
 */
function getTzOffsetMs(date: Date, timeZone: string): number {
  const parts = getDateParts(date, timeZone);
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUTC - date.getTime();
}

/**
 * Computes the next real UTC instant at which timeZone's wall clock reads hour:minute, starting the
 * search from now (rolling over to tomorrow if that time already passed today). Approximates the DST
 * offset using "now"'s offset rather than the target day's -- at most off by an hour, at most twice a
 * year, which is an acceptable margin for a once-a-night batch job.
 */
export function nextRunAt(now: Date, timeZone: string, hour: number, minute: number): Date {
  const offsetMs = getTzOffsetMs(now, timeZone);
  const dateParts = getDateParts(now, timeZone);

  let target = Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, hour, minute, 0) - offsetMs;

  if (target <= now.getTime()) {
    target += 24 * 60 * 60 * 1000;
  }

  return new Date(target);
}

let timer: NodeJS.Timeout | undefined;
let inFlight: Promise<void> | undefined;
let stopped = false;

async function runAndReschedule(): Promise<void> {
  try {
    const result = await runNightlyPipeline();
    console.log('INFO Scheduled nightly pipeline finished: ' + JSON.stringify(result));
  } catch (error) {
    if (error instanceof LockHeldError) {
      console.log('INFO Scheduled nightly run skipped -- another run is already active');
    } else {
      console.error('ERROR Scheduled nightly pipeline failed: ' + error);
    }
  }
  inFlight = undefined;
  if (!stopped) {
    scheduleNext();
  }
}

function scheduleNext(): void {
  const delayMs =
    nextRunAt(new Date(), config.nightly.tz, NIGHTLY_HOUR, NIGHTLY_MINUTE).getTime() - Date.now();
  timer = setTimeout(() => {
    inFlight = runAndReschedule().catch(error => {
      console.error('ERROR Nightly scheduler tick crashed: ' + error);
      inFlight = undefined;
    });
  }, delayMs);
}

/**
 * Starts the in-process nightly scheduler -- runs inside the same Node process as the API server, so it
 * inherits the exact same environment/config, with no external cron daemon or wrapper script needed.
 */
export function startNightlyScheduler(): void {
  console.log(
    'INFO Nightly scheduler started (tz=' +
      config.nightly.tz +
      ', target ' +
      String(NIGHTLY_HOUR).padStart(2, '0') +
      ':' +
      String(NIGHTLY_MINUTE).padStart(2, '0') +
      ')'
  );
  stopped = false;
  scheduleNext();
}

/**
 * Stops the scheduler and waits -- up to `timeoutMs` -- for any in-flight nightly run to finish, so a
 * graceful shutdown doesn't hard-kill a running pipeline and leave a stale processing_lock behind (the
 * lock is only cleared when the stale threshold `config.nightly.lockStaleMs` elapses).
 * Resolves `true` when no run was in flight or it finished within the timeout; `false` if the run was
 * still going when the timeout elapsed (the caller should then exit non-zero).
 */
export async function stopNightlyScheduler(timeoutMs: number): Promise<boolean> {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (!inFlight) {
    return true;
  }
  let timeoutId: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>(resolve => {
    timeoutId = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = await Promise.race([inFlight.then(() => true), timeout]);
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
  return settled;
}
