import {
  getCurrentVersion,
  insertNextVersion,
  MemoryArchiveRow
} from '../database/models/memory_archive.model';

export const MOOD_FILE_PATH = 'self-reflection/mood.md';

// Valence and energy live in [-1, 1]; 0 is neutral. The half-life is measured in days and is set by
// the nightly agent per update (a heated argument lingers ~3 days, a nice compliment ~1).
export interface MoodState {
  valence: number;
  energy: number;
  halfLifeDays: number;
  updatedAt: Date;
}

/** Below this absolute change the decayed mood is considered unchanged, so no new version is written */
const DECAY_EPSILON = 0.01;

const NUM_FIELD_RES: Record<string, RegExp> = {
  valence: /^valence:\s*(-?\d+(?:\.\d+)?)\s*$/m,
  energy: /^energy:\s*(-?\d+(?:\.\d+)?)\s*$/m,
  halfLifeDays: /^halfLifeDays:\s*(\d+(?:\.\d+)?)\s*$/m,
  updatedAt: /^updatedAt:\s*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?)\s*$/m
};

/**
 * Clamps a value into [min, max] -- mood fields stay on their fixed scale.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Parses the machine-readable mood header the nightly agent writes at the top of
 * self-reflection/mood.md. Returns null when any numeric field is missing or unparsable --
 * callers treat that as "no mood state to decay" rather than guessing.
 */
export function parseMood(content: string): MoodState | null {
  const valenceMatch = NUM_FIELD_RES['valence'].exec(content);
  const energyMatch = NUM_FIELD_RES['energy'].exec(content);
  const halfLifeMatch = NUM_FIELD_RES['halfLifeDays'].exec(content);
  const updatedMatch = NUM_FIELD_RES['updatedAt'].exec(content);

  if (!valenceMatch || !energyMatch || !halfLifeMatch || !updatedMatch) {
    return null;
  }

  const updatedAt = new Date(
    updatedMatch[1].length === 10 ? updatedMatch[1] + 'T00:00:00Z' : updatedMatch[1]
  );
  if (isNaN(updatedAt.getTime())) {
    return null;
  }

  return {
    valence: clamp(parseFloat(valenceMatch[1] as string), -1, 1),
    energy: clamp(parseFloat(energyMatch[1] as string), -1, 1),
    halfLifeDays: Math.max(parseFloat(halfLifeMatch[1] as string), 0.25),
    updatedAt
  };
}

/**
 * Renders the canonical machine-readable header the parser expects. The nightly agent's staged
 * file must use this exact field block; keep them byte-compatible.
 */
export function renderMoodHeader(mood: MoodState): string {
  const iso = mood.updatedAt.toISOString();
  return (
    'valence: ' +
    mood.valence +
    '\n' +
    'energy: ' +
    mood.energy +
    '\n' +
    'halfLifeDays: ' +
    mood.halfLifeDays +
    '\n' +
    'updatedAt: ' +
    iso
  );
}

/**
 * Deterministic exponential decay: both valence and energy fade toward neutral (0) with the
 * mood's own half-life, without any agent call. Mood does not "mature" like a trait -- it fades.
 */
export function applyDecay(mood: MoodState, now: Date): MoodState {
  const elapsedDays = Math.max(0, (now.getTime() - mood.updatedAt.getTime()) / (24 * 60 * 60 * 1000));
  const factor = Math.pow(0.5, elapsedDays / mood.halfLifeDays);
  /**
   * Applies the elapsed-time decay factor to a single mood value, snapping
   * near-zero results to exactly zero (the mood fully faded on that axis).
   */
  const decay = (value: number): number => {
    const next = value * factor;
    return Math.abs(next) < DECAY_EPSILON ? 0 : clamp(next, -1, 1);
  };
  return {
    valence: decay(mood.valence),
    energy: decay(mood.energy),
    halfLifeDays: mood.halfLifeDays,
    updatedAt: now
  };
}

/** True when the decayed state differs from the stored one by more than the write threshold */
export function isSignificantChange(before: MoodState, after: MoodState): boolean {
  return (
    Math.abs(before.valence - after.valence) >= DECAY_EPSILON ||
    Math.abs(before.energy - after.energy) >= DECAY_EPSILON
  );
}

/**
 * Applies deterministic decay to the archived mood file, if one exists and is stale.
 * Pure code -- no agent call. The nightly agent still owns mood *updates* (reason, new
 * valence/energy from today's evidence); this only fades an existing state toward neutral
 * between updates, so a mood from a heated argument genuinely stops influencing Yasmin after
 * its half-life instead of lingering forever.
 */
export async function decayMoodFile(now: Date = new Date()): Promise<boolean> {
  let current: MemoryArchiveRow | null = null;
  try {
    current = await getCurrentVersion(MOOD_FILE_PATH);
  } catch (error) {
    console.error('ERROR Failed to read ' + MOOD_FILE_PATH + ' for decay: ' + error);
    return false;
  }

  if (!current) {
    return false;
  }

  const stored = parseMood(current.content);
  if (!stored) {
    console.warn('WARN ' + MOOD_FILE_PATH + ' has no parsable mood header; skipping decay');
    return false;
  }

  const decayed = applyDecay(stored, now);
  if (!isSignificantChange(stored, decayed)) {
    return false;
  }

  const updatedContent = renderMoodHeader(decayed) + '\n\n' + stripMoodHeader(current.content);

  try {
    await insertNextVersion(MOOD_FILE_PATH, updatedContent, now);
    return true;
  } catch (error) {
    console.error('ERROR Failed to persist decayed ' + MOOD_FILE_PATH + ': ' + error);
    return false;
  }
}

/**
 * Replaces the agent-staged updatedAt field with the authoritative archive stamp. The agent's
 * date is untrusted text: a wrong or hallucinated value would silently skew (or freeze) every
 * later decay, so decay always measures from when the run actually archived the update.
 */
export function stampMoodUpdatedAt(content: string, stampedAt: Date): string {
  const mood = parseMood(content);
  if (!mood) {
    return content;
  }
  return renderMoodHeader({ ...mood, updatedAt: stampedAt }) + '\n\n' + stripMoodHeader(content);
}

/** Removes the machine-readable header lines, keeping the agent-written narrative below them */
export function stripMoodHeader(content: string): string {
  return content
    .split('\n')
    .filter(line => !/^(valence|energy|halfLifeDays|updatedAt):/.test(line.trim()))
    .join('\n')
    .replace(/^\s+/, '')
    .trim();
}
