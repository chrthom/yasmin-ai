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
