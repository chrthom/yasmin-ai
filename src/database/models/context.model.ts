import { executeQuery } from '../connection';

export interface ContextEntry {
  title: string;
  content: string;
}

/**
 * Retrieves all entries (title + content) from the database
 */
export async function getAllEntriesFromDb(): Promise<ContextEntry[]> {
  try {
    const [rows]: any = await executeQuery('SELECT title, content FROM context_entries');
    return rows.map((row: any) => ({ title: row.title, content: row.content }));
  } catch (error) {
    console.error('Error retrieving all entries:', error);
    return [];
  }
}

/**
 * Retrieves all titles from the database
 */
export async function getAllTitlesFromDb(): Promise<string[]> {
  try {
    const [rows]: any = await executeQuery('SELECT title FROM context_entries');
    return rows.map((row: any) => row.title);
  } catch (error) {
    console.error('Error retrieving all titles:', error);
    return [];
  }
}

/**
 * Retrieves the content for a given title
 */
export async function getContentByTitleFromDb(title: string): Promise<string | null> {
  try {
    const [rows]: any = await executeQuery('SELECT content FROM context_entries WHERE title = ? LIMIT 1', [
      title
    ]);
    if (rows && rows.length > 0) {
      return rows[0].content;
    }
    return null;
  } catch (error) {
    console.error(`Error retrieving content for title "${title}":`, error);
    return null;
  }
}

/**
 * Inserts a new context entry
 * @param title The title of the entry
 * @param content The content text (Markdown format)
 * @returns Promise<void>
 */
export async function insertContextEntry(title: string, content: string): Promise<void> {
  try {
    await executeQuery('INSERT INTO context_entries (title, content) VALUES (?, ?)', [title, content]);
    console.log(`Inserted context entry "${title}" successfully`);
  } catch (error) {
    console.error('Error inserting context entry:', error);
    throw error;
  }
}

/**
 * Updates an existing context entry
 * @param title The exact title of the entry to update
 * @param newContent The new content text (optional)
 * @param newTitle The new title (optional)
 * @returns Promise<boolean> True if update was successful
 */
export async function updateContextEntry(
  title: string,
  newContent?: string,
  newTitle?: string
): Promise<boolean> {
  try {
    const fields: string[] = [];
    const values: any[] = [];

    if (newTitle !== undefined) {
      fields.push('title = ?');
      values.push(newTitle);
    }

    if (newContent !== undefined) {
      fields.push('content = ?');
      values.push(newContent);
    }

    if (fields.length === 0) {
      return true; // Nothing to update
    }

    values.push(title);
    const query = `UPDATE context_entries SET ${fields.join(', ')} WHERE title = ?`;

    const [result]: any = await executeQuery(query, values);
    return result.affectedRows > 0;
  } catch (error) {
    console.error(`Error updating context entry "${title}":`, error);
    return false;
  }
}

/**
 * Deletes a context entry
 * @param title The title of the entry to delete
 * @returns Promise<boolean> True if deletion was successful
 */
export async function deleteContextEntry(title: string): Promise<boolean> {
  try {
    const [result]: any = await executeQuery('DELETE FROM context_entries WHERE title = ?', [title]);
    return result.affectedRows > 0;
  } catch (error) {
    console.error(`Error deleting context entry "${title}":`, error);
    return false;
  }
}

/**
 * Lists all context entries
 * @returns Promise<Array<{title: string, content: string}>>
 */
export async function listContextEntries(): Promise<Array<{ title: string; content: string }>> {
  try {
    const [rows]: any = await executeQuery('SELECT title, content FROM context_entries ORDER BY title');
    return rows;
  } catch (error) {
    console.error('Error listing context entries:', error);
    return [];
  }
}
