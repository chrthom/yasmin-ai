// Unit tests for the deterministic mood model (src/nightly/mood.ts): parsing, exponential decay,
// and the archive-backed decay write path. The archive model is mocked so no DB is needed.
jest.mock('../database/models/memory_archive.model', () => ({
  getCurrentVersion: jest.fn(),
  insertNextVersion: jest.fn()
}));

import { getCurrentVersion, insertNextVersion } from '../database/models/memory_archive.model';
import {
  applyDecay,
  decayMoodFile,
  isSignificantChange,
  MOOD_FILE_PATH,
  parseMood,
  renderMoodHeader,
  stampMoodUpdatedAt,
  stripMoodHeader
} from '../nightly/mood';

const mockGetCurrentVersion = getCurrentVersion as jest.Mock;
const mockInsertNextVersion = insertNextVersion as jest.Mock;

const UPDATED_AT = new Date('2026-10-01T22:00:00Z');

function moodFile(valence: number, energy: number, halfLifeDays: number, updatedAt: Date): string {
  return (
    renderMoodHeader({ valence, energy, halfLifeDays, updatedAt }) +
    '\n\nToday was a heated argument with Christopher.'
  );
}

describe('mood', () => {
  beforeEach(() => {
    mockGetCurrentVersion.mockReset();
    mockInsertNextVersion.mockReset();
  });

  describe('parseMood', () => {
    it('parses the machine-readable header', () => {
      const mood = parseMood(moodFile(0.6, -0.4, 3, UPDATED_AT));
      expect(mood).toEqual({
        valence: 0.6,
        energy: -0.4,
        halfLifeDays: 3,
        updatedAt: UPDATED_AT
      });
    });

    it('accepts a date-only updatedAt', () => {
      const mood = parseMood('valence: 0.5\nenergy: 0.5\nhalfLifeDays: 1\nupdatedAt: 2026-10-01');
      expect(mood).not.toBeNull();
      expect(mood!.updatedAt).toEqual(new Date('2026-10-01T00:00:00Z'));
    });

    it('clamps out-of-range values and floors the half-life', () => {
      const mood = parseMood('valence: 5\nenergy: -9\nhalfLifeDays: 0\nupdatedAt: 2026-10-01');
      expect(mood!.valence).toBe(1);
      expect(mood!.energy).toBe(-1);
      expect(mood!.halfLifeDays).toBeGreaterThanOrEqual(0.25);
    });

    it('returns null when a field is missing or the date is unparsable', () => {
      expect(parseMood('energy: 0.5\nhalfLifeDays: 1\nupdatedAt: 2026-10-01')).toBeNull();
      expect(parseMood('valence: x\nenergy: 0.5\nhalfLifeDays: 1\nupdatedAt: 2026-10-01')).toBeNull();
      expect(parseMood('valence: 0.5\nenergy: 0.5\nhalfLifeDays: 1\nupdatedAt: not-a-date')).toBeNull();
    });
  });

  describe('applyDecay (deterministic, no agent call)', () => {
    it('halves the mood exactly at the half-life', () => {
      const mood = { valence: 0.8, energy: 0.4, halfLifeDays: 3, updatedAt: UPDATED_AT };
      const now = new Date('2026-10-04T22:00:00Z'); // exactly 3 days later
      const decayed = applyDecay(mood, now);
      expect(decayed.valence).toBeCloseTo(0.4, 10);
      expect(decayed.energy).toBeCloseTo(0.2, 10);
      // A fresh write is not significant at exactly the half-life... actually it is: 0.4 >= 0.01
      expect(isSignificantChange(mood, decayed)).toBe(true);
    });

    it('decays to ~zero after many half-lives', () => {
      const mood = { valence: 0.8, energy: -0.8, halfLifeDays: 1, updatedAt: UPDATED_AT };
      const now = new Date('2026-10-15T22:00:00Z'); // 14 half-lives
      const decayed = applyDecay(mood, now);
      expect(decayed.valence).toBe(0);
      expect(decayed.energy).toBe(0);
    });

    it('treats a fully-neutralized mood as no longer significant on a SECOND decay pass', () => {
      const neutral = { valence: 0, energy: 0, halfLifeDays: 1, updatedAt: UPDATED_AT };
      const secondPass = applyDecay(neutral, new Date('2026-10-15T22:00:00Z'));
      expect(isSignificantChange(neutral, secondPass)).toBe(false);
    });

    it('leaves an already-neutral mood alone (no churn from decay)', () => {
      const mood = { valence: 0, energy: 0, halfLifeDays: 2, updatedAt: UPDATED_AT };
      const decayed = applyDecay(mood, new Date('2026-10-05T22:00:00Z'));
      expect(isSignificantChange(mood, decayed)).toBe(false);
    });

    it('never decays backwards in time', () => {
      const mood = { valence: 0.8, energy: 0.5, halfLifeDays: 3, updatedAt: UPDATED_AT };
      const decayed = applyDecay(mood, new Date('2026-09-30T22:00:00Z'));
      expect(decayed.valence).toBeCloseTo(0.8, 10);
      expect(decayed.energy).toBeCloseTo(0.5, 10);
    });
  });

  describe('decayMoodFile', () => {
    it('applies decay and persists a new version when the change is significant', async () => {
      mockGetCurrentVersion.mockResolvedValue({
        content: moodFile(0.8, 0.6, 1, UPDATED_AT),
        filePath: MOOD_FILE_PATH
      });
      mockInsertNextVersion.mockResolvedValue({ created: true });

      const now = new Date('2026-10-02T22:00:00Z'); // one half-life later
      const changed = await decayMoodFile(now);

      expect(changed).toBe(true);
      expect(mockInsertNextVersion).toHaveBeenCalledWith(MOOD_FILE_PATH, expect.any(String), now);
      const [path, content] = mockInsertNextVersion.mock.calls[0];
      expect(path).toBe(MOOD_FILE_PATH);
      const mood = parseMood(content);
      expect(mood).not.toBeNull();
      expect(mood!.valence).toBeCloseTo(0.4, 10);
      expect(mood!.energy).toBeCloseTo(0.3, 10);
      // The narrative is preserved below the refreshed header
      expect(content).toContain('Today was a heated argument with Christopher.');
    });

    it('writes nothing when decay applies without a significant change (deterministic decay without an agent update)', async () => {
      mockGetCurrentVersion.mockResolvedValue({
        content: moodFile(0, 0, 2, UPDATED_AT)
      });
      const changed = await decayMoodFile(new Date('2026-10-05T22:00:00Z'));
      expect(changed).toBe(false);
      expect(mockInsertNextVersion).not.toHaveBeenCalled();
    });

    it('does nothing when no mood file exists yet', async () => {
      mockGetCurrentVersion.mockResolvedValue(null);
      expect(await decayMoodFile(new Date())).toBe(false);
      expect(mockInsertNextVersion).not.toHaveBeenCalled();
    });

    it('skips decay when the stored header is unparsable', async () => {
      mockGetCurrentVersion.mockResolvedValue({ content: 'no header here' });
      expect(await decayMoodFile(new Date())).toBe(false);
      expect(mockInsertNextVersion).not.toHaveBeenCalled();
    });
  });

  describe('stampMoodUpdatedAt', () => {
    it('overwrites the agent-supplied updatedAt with the authoritative archive stamp', () => {
      const agentLie =
        'valence: 0.8\nenergy: 0.6\nhalfLifeDays: 1\nupdatedAt: 2030-01-01T00:00:00Z\n\nReason.';
      const stamp = new Date('2026-10-02T22:00:00Z');
      const stamped = stampMoodUpdatedAt(agentLie, stamp);
      const mood = parseMood(stamped);
      expect(mood!.updatedAt).toEqual(stamp);
      expect(mood!.valence).toBe(0.8);
      expect(stamped).toContain('Reason.');
    });

    it('returns the content untouched when the header is unparsable', () => {
      const broken = 'kein header';
      expect(stampMoodUpdatedAt(broken, new Date())).toBe(broken);
    });
  });

  describe('stripMoodHeader', () => {
    it('removes only the header lines and keeps the narrative', () => {
      const content = moodFile(0.5, 0.5, 1, UPDATED_AT);
      const narrative = stripMoodHeader(content);
      expect(narrative).toBe('Today was a heated argument with Christopher.');
      expect(narrative).not.toMatch(/valence|energy|halfLifeDays|updatedAt/);
    });
  });
});
