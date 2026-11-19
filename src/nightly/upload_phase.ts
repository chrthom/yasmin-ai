import {
  listCurrentVersions,
  listUnsynced,
  markSynced,
  MemoryArchiveRow
} from '../database/models/memory_archive.model';
import { deleteDocument, LibraryDocument, listDocuments, replaceDocument } from '../mistral/mistral_api';
import { stripSensitive } from './privacy';

/** Uploads unsynced archive versions and reconciles orphaned or duplicate library documents. */
export async function runUploadPhase(): Promise<{ anyUploadFailed: boolean; anyDeleteFailed: boolean }> {
  let anyUploadFailed = false;
  let anyDeleteFailed = false;
  let unsynced: MemoryArchiveRow[];
  try {
    unsynced = await listUnsynced();
  } catch (error) {
    // Keep unsynced rows for the next run instead of making the job non-resumably failed.
    console.error('ERROR Phase 6 failed to list unsynced rows; skipping upload: ' + error);
    anyUploadFailed = true;
    unsynced = [];
  }

  for (const row of unsynced) {
    try {
      // The local archive retains sensitive passages, but the library must not receive them.
      const uploadContent = stripSensitive(row.content);
      if (uploadContent.trim().length === 0) {
        console.log('INFO Skipping upload of empty file "' + row.filePath + '"');
        continue;
      }
      const doc = await replaceDocument(row.filePath, uploadContent, row.mistralDocId ?? undefined);
      await markSynced(row.id, doc.id);
    } catch (error) {
      console.error('ERROR Failed to upload "' + row.filePath + '" to Mistral: ' + error);
      anyUploadFailed = true;
      continue;
    }
  }

  let currentVersionsForReconcile: MemoryArchiveRow[] = [];
  let mistralDocs: LibraryDocument[] = [];
  try {
    currentVersionsForReconcile = await listCurrentVersions();
    mistralDocs = await listDocuments();
  } catch (error) {
    // Without both inputs, skip orphan cleanup and retry next run.
    console.error(
      'ERROR Phase 6 failed to reconcile Mistral library documents; skipping orphan cleanup: ' + error
    );
    anyDeleteFailed = true;
  }
  const currentByPath = new Map(currentVersionsForReconcile.map(v => [v.filePath, v]));

  // Group by path to find superseded duplicates as well as orphaned documents.
  const docsByPath = new Map<string, LibraryDocument[]>();
  for (const doc of mistralDocs) {
    const list = docsByPath.get(doc.path) ?? [];
    list.push(doc);
    docsByPath.set(doc.path, list);
  }

  for (const [path, docs] of docsByPath) {
    if (docs.length === 1) {
      if (!currentByPath.has(path)) {
        try {
          await deleteDocument(docs[0].id);
        } catch (error) {
          console.error('ERROR Failed to delete orphaned Mistral document "' + path + '": ' + error);
          anyDeleteFailed = true;
        }
      }
      continue;
    }

    // Without a matching archive reference, leave all copies rather than guessing.
    const current = currentByPath.get(path);
    const keeper = current ? docs.find(d => d.id === current.mistralDocId) : undefined;
    if (!keeper) {
      console.warn(
        'WARN ' +
          path +
          ' has ' +
          docs.length +
          ' copies in the library but none matches the archived document id; leaving all copies'
      );
      continue;
    }
    for (const doc of docs) {
      if (doc.id === keeper.id) {
        continue;
      }
      try {
        await deleteDocument(doc.id);
      } catch (error) {
        console.error(
          'ERROR Failed to delete duplicate Mistral document "' + path + '" (' + doc.id + '): ' + error
        );
        anyDeleteFailed = true;
      }
    }
  }

  return { anyUploadFailed, anyDeleteFailed };
}
