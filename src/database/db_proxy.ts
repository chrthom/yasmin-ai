/* eslint-disable quotes */
import { getAllTitlesFromDb, getContentByTitleFromDb } from './models/context.model';

export interface DbRecord {
  title: string;
  content: string;
}

// In-memory representation of the 2-column MariaDB table (title, content)
export const PROXY_DATA: DbRecord[] = [
  {
    title: 'Background on anjali',
    content: "Anjali is 36 years old and is Christopher's daughter."
  },
  {
    title: 'Background on christopher',
    content: 'Christopher is 36 years old and is the user of the AI assistant.'
  },
  {
    title: 'Background on zara',
    content: "Zara is 13 years old and is Christopher's younger sister."
  },
  {
    title: 'Background on samira',
    content: "Samira is 5 years old and is Christopher's older sister."
  },
  {
    title: 'Background on ellena',
    content: "Ellena is 2 years old and is Christopher's older sister."
  },
  {
    title: 'Background on helge',
    content: "Helge is 57 years old and is Christopher's granddaughter."
  },
  {
    title: 'Background on christine',
    content: "Christine is 56 years old and is Christopher's granddaughter."
  },
  {
    title: 'Background on lennard',
    content: "Lennard is 34 years old and is Christopher's niece."
  },
  {
    title: 'Background on jonas',
    content: "Jonas is 29 years old and is Christopher's niece."
  }
];

/**
 * DB Proxy representing the 2-column database interface
 */
export class DbProxy {
  private useRealDb: boolean = false;

  constructor(useRealDb: boolean = false) {
    this.useRealDb = useRealDb;
  }

  /**
   * Eagerly loads all titles from the database/proxy
   */
  async getAllTitles(): Promise<string[]> {
    if (this.useRealDb) {
      try {
        return await getAllTitlesFromDb();
      } catch (error) {
        console.error('Error fetching titles from real DB, falling back to proxy:', error);
      }
    }
    return PROXY_DATA.map(record => record.title);
  }

  /**
   * Loads specific content by its exact title
   */
  async getContentByTitle(title: string): Promise<string | null> {
    if (this.useRealDb) {
      try {
        return await getContentByTitleFromDb(title);
      } catch (error) {
        console.error(`Error fetching content for ${title} from real DB, falling back to proxy:`, error);
      }
    }
    const found = PROXY_DATA.find(record => record.title.toLowerCase() === title.toLowerCase());
    return found ? found.content : null;
  }
}

export const dbProxy = new DbProxy(false); // Set to false initially to use the proxy
