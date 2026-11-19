import { config } from '../config';
import { upsertContextEntry } from '../database/models/context.model';
import {
  getCurrentVersion,
  listCurrentVersions,
  MemoryArchiveRow
} from '../database/models/memory_archive.model';
import { personNameFromTitle } from '../strings';
import {
  DREAM_EVIDENCE_HEADER,
  DREAM_EVIDENCE_MAX_CHARS,
  DREAM_REFLECTION_PATH,
  recentDreamReflections
} from './dream';
import { pathToTitle } from './mapping';
import { MOOD_FILE_PATH, parseMood, stripMoodHeader } from './mood';
import { isOverCap, stripSensitive, truncateToCap } from './privacy';
import { CompactKind, runCompact } from './reflection';

/**
 * Regenerates mapped eager entries, privacy-stripping profile, mood and dream evidence.
 * Yasmin's profile is eagerly loaded for every sender, so its mood/dream fold-ins must be stripped
 * before compaction too. Dream reflections are first-person self-concept, not factual evidence:
 * this one-way fold-in is their only direct bridge into an eager profile (issue #126), never into
 * people/ or general/ profiles. Facts require the normal journal/integrate/review evidence chain.
 *
 * @returns True if loading archive versions or regenerating any mapped entry failed (partial job
 * status); false means no failure, including safe skips of unmapped files or empty compactions.
 */
export async function runEagerPhase(): Promise<boolean> {
  let anyEagerFailed = false;
  let allCurrentVersions: MemoryArchiveRow[];
  try {
    allCurrentVersions = await listCurrentVersions();
  } catch (error) {
    // Leave the cache untouched and retry next run.
    console.error(
      'ERROR Phase 7 failed to load current versions; leaving the eager cache untouched: ' + error
    );
    anyEagerFailed = true;
    allCurrentVersions = [];
  }

  for (const row of allCurrentVersions) {
    const title = pathToTitle(row.filePath);
    if (title === null) {
      continue;
    }

    let kind: CompactKind;
    let personName: string | undefined;

    if (row.filePath === 'self-reflection/profile.md') {
      kind = 'yasmin';
    } else if (row.filePath === 'general/family.md') {
      kind = 'family';
    } else {
      const name = personNameFromTitle(title);
      if (name === null) {
        console.error('ERROR Phase 7 could not derive a person name from title "' + title + '"');
        anyEagerFailed = true;
        continue;
      }
      kind = 'person';
      personName = name;
    }

    try {
      const stripped = stripSensitive(row.content);
      let compactSource = stripped;
      if (kind === 'yasmin') {
        // Mood and dream reflections have no eager entry of their own; only Yasmin's profile folds them in.
        const moodRow = await getCurrentVersion(MOOD_FILE_PATH);
        if (moodRow) {
          const mood = parseMood(moodRow.content);
          if (!mood) {
            console.warn('WARN ' + MOOD_FILE_PATH + ' has no parsable mood header; skipping mood fold-in');
          }
          if (mood) {
            const moodNarrative = stripSensitive(stripMoodHeader(moodRow.content));
            // A fully faded mood has no narrative; do not fold in stale values.
            if (moodNarrative.length > 0) {
              const header =
                '\n\n## My current mood\nvalence: ' +
                mood.valence +
                ', energy: ' +
                mood.energy +
                ', half-life: ' +
                mood.halfLifeDays +
                ' days\n\n';
              compactSource = stripped + header + moodNarrative;
            }
          }
        }
        // Reflections are soft evidence, stripped before they reach the eagerly loaded profile.
        const dreamsRow = await getCurrentVersion(DREAM_REFLECTION_PATH);
        if (dreamsRow) {
          const reflections = stripSensitive(
            recentDreamReflections(dreamsRow.content, DREAM_EVIDENCE_MAX_CHARS)
          );
          if (reflections.length > 0) {
            compactSource = compactSource + '\n\n' + DREAM_EVIDENCE_HEADER + '\n\n' + reflections;
          }
        }
      }
      let compacted = await runCompact(kind, personName, compactSource);

      if (compacted.trim().length === 0) {
        console.log(
          'INFO Phase 7 compaction produced empty output for "' +
            row.filePath +
            '"; skipping eager-cache update (no content)'
        );
        continue;
      }

      if (isOverCap(compacted, config.nightly.eagerMaxChars)) {
        compacted = truncateToCap(compacted, config.nightly.eagerMaxChars);
      }

      await upsertContextEntry(title, compacted);
    } catch (error) {
      console.error('ERROR Failed to regenerate eager cache entry for "' + row.filePath + '": ' + error);
      anyEagerFailed = true;
    }
  }

  return anyEagerFailed;
}
