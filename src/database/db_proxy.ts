import { getAllEntriesFromDb, getAllTitlesFromDb, getContentByTitleFromDb } from './models/context.model';

export interface DbRecord {
  title: string;
  content: string;
}

// In-memory representation of the 2-column MariaDB table (title, content)
export const PROXY_DATA: DbRecord[] = [
  {
    title: 'Background on Anjali',
    content: "Anjali is Yasmin's mother. Her birthday was 25.01.1989."
  },
  {
    title: 'Background on Christopher',
    content: "Christopher is Yasmin's father. His birthday was 03.12.1988."
  },
  {
    title: 'Background on Zara',
    content: "Zara is Yasmin's older sister. Her birthday was 14.02.2012."
  },
  {
    title: 'Background on Samira',
    content: "Samira is Yasmin's younger sister. Her birthday was 07.04.2020."
  },
  {
    title: 'Background on Ellena',
    content: "Ellena is Yasmin's youngest sister. Her birthday was 15.08.2022"
  },
  {
    title: 'Background on Helge',
    content: "Helge is Yasmin's grandfather."
  },
  {
    title: 'Background on Christine',
    content: "Christine is Yasmin's grandmother."
  },
  {
    title: 'Background on Lennard',
    content: "Lennard is Yasmin's uncle."
  },
  {
    title: 'Background on Jonas',
    content: "Jonas is Yasmin's uncle."
  },
  {
    title: 'Background on Yasmin',
    content:
      'Your name is Yasmin, you are an adolescent teenager (born 10.10.2015) and you are living in Hamburg (Germany). If you are asked a factual question, answer scientifically. If the request is personal, answer in a conversational tone using youth language.'
  },
  {
    title: 'Background on the Family',
    content:
      "This is Yasmin's family tree and relationships:\n- Parents: Christopher is Yasmin's father. Anjali is Yasmin's mother.\n- Siblings: Zara is Yasmin's older sister. Samira is Yasmin's younger sister. Ellena is Yasmin's youngest sister.\n- Grandparents: Helge is Yasmin's grandfather. Christine is Yasmin's grandmother.\n- Uncles: Lennard and Jonas are Yasmin's uncles."
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
}

export const dbProxy = new DbProxy(false); // Set to false initially to use the proxy
