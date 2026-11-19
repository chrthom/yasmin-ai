import {
  getCurrentVersion,
  insertNextVersion,
  listCurrentVersions
} from '../database/models/memory_archive.model';
import { updateJobLog } from '../database/models/nightly_job.model';
import {
  DREAM_REFLECTION_PATH,
  appendDreamReflection,
  dreamDateFromPath,
  dreamFilePath,
  findLastDreamAt,
  findUnreflectedDream,
  runDream,
  runDreamReflection,
  selectDreamSources,
  shouldDreamTonight
} from './dream';

/**
 * Generates a dream and catches up its reflection, preserving the per-date resume guards.
 * Per-date dream files and dated reflection headers prevent duplicates, including catch-up of
 * earlier unreflected dreams. A failure marks the phase partial without a completion stamp so
 * nightly_job_log retains the last phase that actually succeeded.
 *
 * @param jobId - Job log row to stamp only after both stages succeed (or safely skip).
 * @param collectedAt - Snapshot time used for the dream date and archive timestamps.
 * @returns Flags indicating a durable dream exists for this date and whether any stage or stamp failed;
 * the latter drives partial job status, even if the dream was already archived.
 */
export async function runDreamPhase(
  jobId: number,
  collectedAt: Date
): Promise<{
  dreamGenerated: boolean;
  anyDreamFailed: boolean;
}> {
  let dreamGenerated = false;
  let anyDreamFailed = false;
  try {
    const currentVersionsForDream = await listCurrentVersions();
    const dreamPath = dreamFilePath(collectedAt);
    const dreamRow = await getCurrentVersion(dreamPath);

    if (dreamRow) {
      // Stage 1 is already durably done for this date -- only the reflection may be missing.
      dreamGenerated = true;
    } else if (!shouldDreamTonight(findLastDreamAt(currentVersionsForDream), Math.random)) {
      console.log('INFO No dream tonight (cadence)');
    } else {
      const sources = selectDreamSources(currentVersionsForDream, collectedAt, Math.random);
      if (sources.length < 2) {
        console.log('INFO Too few old journals to dream from; skipping dream phase');
      } else {
        const dreamText = await runDream(sources);
        // The live prompt calls library content "YOUR MEMORY"; this self-describing header keeps
        // retrieved dream events distinguishable from things that actually happened.
        const dateStr = dreamDateFromPath(dreamPath)!;
        const archivedDream =
          'TRAUM -- nicht wirklich passiert. Am ' +
          dateStr +
          ' hatte Yasmin diesen Traum (nur ein Traum, erfunden aus alten Tagebucheintragen):\n\n' +
          dreamText;
        await insertNextVersion(dreamPath, archivedDream, collectedAt);
        dreamGenerated = true;
        console.log('INFO Dream generated from ' + sources.length + ' old journals: ' + dreamPath);
      }
    }

    // Re-list after generation; dated reflection headers also catch up failures from earlier runs.
    const reflectionRow = await getCurrentVersion(DREAM_REFLECTION_PATH);
    const reflectionContent = reflectionRow ? reflectionRow.content : null;
    const versionsAfterDream = await listCurrentVersions();
    const unreflected = findUnreflectedDream(versionsAfterDream, reflectionContent);
    if (unreflected) {
      const dateStr = dreamDateFromPath(unreflected.filePath)!;
      const reflectionText = await runDreamReflection(unreflected.content);
      const nextContent = appendDreamReflection(reflectionContent, dateStr, reflectionText);
      await insertNextVersion(DREAM_REFLECTION_PATH, nextContent, collectedAt);
      console.log(
        'INFO Dream reflection for ' + unreflected.filePath + ' appended to ' + DREAM_REFLECTION_PATH
      );
    }

    await updateJobLog(jobId, { lastCompletedPhase: '5-dream' });
  } catch (error) {
    console.error('ERROR Dream phase failed: ' + error);
    anyDreamFailed = true;
  }
  return { dreamGenerated, anyDreamFailed };
}
