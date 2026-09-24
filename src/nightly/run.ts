#!/usr/bin/env node

import { config, validateEnv } from '../config';
import { getDatabasePool } from '../database/connection';
import { listConversations, listDocuments } from '../mistral/mistral_api';
import { computeSinceIso, LockHeldError, runNightlyPipeline } from './pipeline';

validateEnv();

// Initialize database pool
getDatabasePool();

/**
 * Preflight/connectivity smoke test -- NOT a simulated full run of every phase. It deliberately does
 * not thread a dry-run flag through every write call in the pipeline; it only verifies DB + Mistral
 * connectivity (including that the library id is valid) and reports what a real run would currently see.
 */
async function runDryRun(): Promise<void> {
  console.log('INFO Dry-run mode active -- no data will be written');

  const sinceIso = await computeSinceIso();
  console.log('INFO Computed watermark sinceIso: ' + sinceIso);

  const conversations = (await listConversations(sinceIso)).filter(c => c.agentId === config.mistral.agentId);
  console.log(
    'INFO Would process ' +
      conversations.length +
      ' conversation(s): ' +
      conversations.map(c => c.id + ' (' + (c.name || 'unknown') + ')').join(', ')
  );

  const documents = await listDocuments();
  console.log('INFO Memory library currently has ' + documents.length + ' document(s)');

  console.log('INFO DRY RUN COMPLETE -- no data was written');
}

async function main(): Promise<void> {
  const isDryRun = process.argv.includes('--dry-run');

  if (isDryRun) {
    try {
      await runDryRun();
    } catch (error) {
      console.error('ERROR Dry run failed: ' + error);
      process.exit(1);
    }
    return;
  }

  try {
    const result = await runNightlyPipeline();
    console.log('INFO Nightly pipeline finished: ' + JSON.stringify(result));
    // A 'partial' status still needs operator attention, so exit non-zero to trip the cron
    // wrapper's failure-email check just like a hard 'failed' would.
    process.exit(result.status === 'completed' ? 0 : 1);
  } catch (error) {
    if (error instanceof LockHeldError) {
      console.log('INFO Another run is already active, exiting cleanly');
      process.exit(0);
      return;
    }
    console.error('ERROR Nightly pipeline failed: ' + error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
