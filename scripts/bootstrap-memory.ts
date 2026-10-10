#!/usr/bin/env ts-node

// One-time migration CLI: the memory library and memory_archive table start EMPTY. This script
// reads the CURRENT context_entries table (the existing 'Profile of X' / 'Session with X' /
// 'Profile of Yasmin' / 'Family notes' rows) and seeds memory_archive + the Mistral library from
// them, so the nightly pipeline has a real starting point instead of wiping existing profiles on
// its first run. It is read-only against context_entries.

import { listContextEntries } from '../src/database/models/context.model';
import { insertNextVersion, markSynced } from '../src/database/models/memory_archive.model';
import { uploadDocument } from '../src/mistral/mistral_api';
import { titleToPath } from '../src/nightly/mapping';
import { getDatabasePool, closeDatabasePool } from '../src/database/connection';
import { validateEnv } from '../src/config';

validateEnv({ requireDb: true });


const PROFILE_TITLE_PATTERN = /^Profile of (.+)$/;

interface SeedFile {
  path: string;
  content: string;
}

/** Renders one template section: heading, then (only if body is non-empty) a blank line + body */
function buildSection(heading: string, body: string): string {
  return body.length > 0 ? heading + '\n\n' + body : heading;
}

/**
 * Builds the 7-section person profile template from the existing 'Profile of <name>' and
 * (optional) 'Session with <name>' content, matching reflection.ts's exact section headings. The
 * two sections with no equivalent in the old 2-column data (Ideas/Interests/Goals, Communication
 * Style) start empty; the nightly pipeline fills them in as it observes real signal over time.
 */
function buildPersonProfile(coreFacts: string, sessionContent: string): string {
  return [
    buildSection('## Core Facts', coreFacts),
    buildSection('## Current Attitude', ''),
    buildSection('## Ideas, Interests & Goals', ''),
    buildSection('## Recent Happenings', ''),
    buildSection('## Open Topics', sessionContent),
    buildSection('## Communication Style', ''),
    buildSection("## Yasmin's Intentions", '')
  ].join('\n\n');
}

/**
 * Seeds a single (path, content) pair into memory_archive, uploading to the Mistral library only
 * when the content is genuinely new/changed (insertNextVersion's hash-based no-churn makes this
 * safe to call repeatedly without creating duplicate versions or duplicate uploads).
 */
async function seedFile(file: SeedFile): Promise<boolean> {
  // An empty memory file carries no information and Mistral rejects empty document uploads (HTTP 400),
  // so skip it entirely rather than seeding a useless archive row or failing the bootstrap.
  if (file.content.trim().length === 0) {
    console.log('INFO ' + file.path + ' has no content, skipping seed/upload');
    return false;
  }

  const { row, created } = await insertNextVersion(file.path, file.content);

  if (!created) {
    console.log('INFO ' + file.path + ' already up to date at v' + row.version + ', skipping upload');
    return false;
  }

  const doc = await uploadDocument(file.path, file.content);
  await markSynced(row.id, doc.id);
  console.log('INFO Seeded and uploaded ' + file.path + ' (v' + row.version + ')');
  return true;
}

/**
 * Core migration logic, exported independently of the process lifecycle so tests can call it
 * directly without a real DB pool or triggering process.exit.
 */
export async function bootstrapMemory(): Promise<void> {
  const entries = await listContextEntries();
  const byTitle = new Map(entries.map(entry => [entry.title, entry.content]));

  const seeds: SeedFile[] = [];

  const personNames: string[] = [];
  for (const title of byTitle.keys()) {
    const match = PROFILE_TITLE_PATTERN.exec(title);
    if (match && match[1] !== 'Yasmin') {
      personNames.push(match[1]);
    }
  }

  for (const name of personNames) {
    const path = titleToPath('Profile of ' + name);
    if (!path) {
      console.warn('WARN Could not map "Profile of ' + name + '" to a file path, skipping');
      continue;
    }

    const coreFacts = byTitle.get('Profile of ' + name) || '';
    const sessionContent = byTitle.get('Session with ' + name) || '';
    seeds.push({ path, content: buildPersonProfile(coreFacts, sessionContent) });
  }

  const yasminProfile = byTitle.get('Profile of Yasmin');
  if (yasminProfile !== undefined) {
    // Seeded as-is (verbatim), even though it is currently written in third person -- the nightly
    // pipeline's own compaction step already produces a correctly first-person EAGER cache entry
    // on its very first run regardless of the verbose archive's initial voice, so no bootstrap-time
    // rewriting is needed here.
    seeds.push({ path: 'self-reflection/profile.md', content: yasminProfile });
  }

  const familyNotes = byTitle.get('Family notes');
  if (familyNotes !== undefined) {
    seeds.push({ path: 'general/family.md', content: familyNotes });
  }

  let seededCount = 0;
  let upToDateCount = 0;

  for (const seed of seeds) {
    const wasSeeded = await seedFile(seed);
    if (wasSeeded) {
      seededCount++;
    } else {
      upToDateCount++;
    }
  }

  console.log(
    'INFO Bootstrap complete: ' +
      seededCount +
      ' file(s) newly seeded, ' +
      upToDateCount +
      ' already up to date'
  );
}

async function main(): Promise<void> {
  try {
    getDatabasePool();
    await bootstrapMemory();
  } catch (error) {
    console.error('ERROR Bootstrap memory failed:', error);
    process.exit(1);
  } finally {
    await closeDatabasePool();
  }
}

if (require.main === module) {
  main();
}
