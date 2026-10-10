#!/usr/bin/env ts-node

import {
  insertContextEntry,
  updateContextEntry,
  deleteContextEntry,
  listContextEntries
} from '../src/database/models/context.model';
import { getDatabasePool, closeDatabasePool } from '../src/database/connection';
import { validateEnv } from '../src/config';

validateEnv({ requireDb: true });

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    // Initialize database pool
    getDatabasePool();

    switch (command) {
      case 'list':
        await list();
        break;

      case 'create':
        if (args.length < 3) {
          console.error('Usage: npm run manage-context create <title> <content>');
          process.exit(1);
        }
        await create(args[1], args.slice(2).join(' '));
        break;

      case 'update':
        if (args.length < 3) {
          console.error(
            'Usage: npm run manage-context update <title> [--title <newTitle>] [--content <newContent>]'
          );
          process.exit(1);
        }
        await update(args[1], args);
        break;

      case 'delete':
        if (args.length < 2) {
          console.error('Usage: npm run manage-context delete <title>');
          process.exit(1);
        }
        await deleteEntry(args[1]);
        break;

      default:
        console.log(`
Usage: npm run manage-context <command> [options]

Commands:
  list                         List all context entries (title and content)
  create <title> <content>     Create a new context entry with Markdown prose
  update <title> [options]     Update an existing context entry
  delete <title>               Delete a context entry

Options for update:
  --title <newTitle>           New title
  --content <newContent>       New content prose
        `);
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await closeDatabasePool();
  }
}

async function list() {
  const entries = await listContextEntries();
  console.log('Context Entries:');
  console.log('Title\t\t\t\tContent');
  console.log('-----\t\t\t\t-------');
  for (const entry of entries) {
    console.log(`${entry.title}\t\t${entry.content}`);
  }
}

async function create(title: string, content: string) {
  await insertContextEntry(title, content);
  console.log(`Created context entry with title "${title}"`);
}

async function update(title: string, args: string[]) {
  let newTitle: string | undefined;
  let newContent: string | undefined;

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--title' && i + 1 < args.length) {
      newTitle = args[i + 1];
      i++;
    } else if (args[i] === '--content' && i + 1 < args.length) {
      newContent = args[i + 1];
      i++;
    }
  }

  const success = await updateContextEntry(title, newContent, newTitle);
  if (success) {
    console.log(`Updated context entry "${title}"`);
  } else {
    console.error(`Failed to update context entry "${title}"`);
    process.exit(1);
  }
}

async function deleteEntry(title: string) {
  const success = await deleteContextEntry(title);
  if (success) {
    console.log(`Deleted context entry "${title}"`);
  } else {
    console.error(`Failed to delete context entry "${title}"`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
