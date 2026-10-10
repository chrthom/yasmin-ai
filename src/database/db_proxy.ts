import { getAllEntriesFromDb, getAllTitlesFromDb, getContentByTitleFromDb } from './models/context.model';

export interface DbRecord {
  title: string;
  content: string;
}

// In-memory representation of the 2-column MariaDB table (title, content)
export const PROXY_DATA: DbRecord[] = [
  {
    title: 'Profile of Yasmin',
    content:
      'Yasmin is a half-German, half-Indian adolescent teenager born 10.10.2015 in Hamburg. Yasmin is interested in arts and science.'
  },
  {
    title: 'Profile of Anjali',
    content: "Anjali is Yasmin's mother. Her birthday was 25.01.1989. She lives with Yasmin in Hamburg."
  },
  {
    title: 'Profile of Christopher',
    content: "Christopher is Yasmin's father. His birthday was 03.12.1988. He lives with Yasmin in Hamburg."
  },
  {
    title: 'Profile of Zara',
    content: "Zara is Yasmin's older sister. Her birthday was 14.02.2012. She lives with Yasmin in Hamburg."
  },
  {
    title: 'Profile of Samira',
    content:
      "Samira is Yasmin's younger sister. Her birthday was 07.04.2020. She lives with Yasmin in Hamburg."
  },
  {
    title: 'Profile of Ellena',
    content:
      "Ellena is Yasmin's youngest sister. Her birthday was 15.08.2022. She lives with Yasmin in Hamburg."
  },
  {
    title: 'Profile of Helge',
    content: "Helge is Yasmin's grandfather. He lives in Schleswig."
  },
  {
    title: 'Profile of Christine',
    content: "Christine is Yasmin's grandmother. She lives in Schleswig."
  },
  {
    title: 'Profile of Lennard',
    content: "Lennard is Yasmin's uncle. He lives in Flensburg."
  },
  {
    title: 'Profile of Jonas',
    content: "Jonas is Yasmin's uncle. He lives in Schleswig."
  },
  {
    title: 'Family notes',
    content: ''
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
   * Eagerly loads all entries (title + content) from the database/proxy
   */
  async getAllEntries(): Promise<DbRecord[]> {
    if (this.useRealDb) {
      try {
        return await getAllEntriesFromDb();
      } catch (error) {
        console.error('Error fetching entries from real DB, falling back to proxy:', error);
      }
    }
    return PROXY_DATA;
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
    if (!title) {
      return null;
    }
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

  /**
   * Checks whether a first name is a known person (or Yasmin herself), via the canonical
   * "Profile of [name]" entry titles. Consults the real database first (like the other
   * readers) so people whose profile exists only in context_entries -- e.g. a brand-new
   * person file the nightly integrate agent created -- are recognized too; falls back to
   * the static proxy data when the DB is unavailable or disabled.
   */
  async isKnownPerson(name: string): Promise<boolean> {
    const sought = name.trim().toLowerCase();
    if (sought.length === 0) {
      return false;
    }
    if (this.useRealDb) {
      try {
        const titles = await this.getAllTitles();
        if (titles.some(title => title.toLowerCase() === `profile of ${sought}`)) {
          return true;
        }
      } catch (error) {
        console.error('Error fetching titles from real DB, falling back to proxy:', error);
      }
    }
    return PROXY_DATA.some(
      record =>
        record.title.toLowerCase() === `profile of ${sought}` ||
        (sought === 'yasmin' && record.title === 'Profile of Yasmin')
    );
  }
}

export const dbProxy = new DbProxy(process.env['NODE_ENV'] !== 'test');
