import { dbProxy } from '../database/db_proxy';

export interface ContextRetrievalResult {
  formattedContext: string;
  newlyLoadedTitles: string[];
}

/**
 * Service to orchestrate database queries, TF-IDF relevance matching, and XML formatting
 */
export class ContextService {
  /**
   * Retrieves relevant context for a specific conversation turn, filtering out already loaded blocks
   * @param prompt The incoming user prompt/message
   * @param username The sender username
   * @param loadedTitles Set of titles that have already been loaded/sent in this conversation
   * @returns ContextRetrievalResult containing formatted XML context and any newly loaded titles
   */
  public async getRelevantContext(
    prompt: string,
    username: string,
    loadedTitles: Set<string> | string[]
  ): Promise<ContextRetrievalResult> {
    const loadedSet = loadedTitles instanceof Set ? loadedTitles : new Set(loadedTitles);
    const entries = await dbProxy.getAllEntries();
    const titles = entries.map(e => e.title);

    // 1. Mandatorily match sender background (case-insensitive)
    const userBackgroundTitle = `background on ${username.toLowerCase()}`;
    const matchedUserTitle = titles.find(t => t.toLowerCase() === userBackgroundTitle);

    // Mandatorily match Yasmin's own background (case-insensitive)
    const yasminBackgroundTitle = 'background on yasmin';
    const matchedYasminTitle = titles.find(t => t.toLowerCase() === yasminBackgroundTitle);

    // Mandatorily match Family relations background (case-insensitive)
    const familyBackgroundTitle = 'background on the family';
    const matchedFamilyTitle = titles.find(t => t.toLowerCase() === familyBackgroundTitle);

    // Identify candidate titles for injection
    const candidateTitles: string[] = [];
    if (matchedYasminTitle && !loadedSet.has(matchedYasminTitle)) {
      candidateTitles.push(matchedYasminTitle);
    }

    if (matchedFamilyTitle && !loadedSet.has(matchedFamilyTitle)) {
      candidateTitles.push(matchedFamilyTitle);
    }

    if (matchedUserTitle && !loadedSet.has(matchedUserTitle)) {
      candidateTitles.push(matchedUserTitle);
    }

    // 3. Load actual contents and format as clean XML
    const xmlBlocks: string[] = [];
    const newlyLoadedTitles: string[] = [];

    for (const title of candidateTitles) {
      const content = await dbProxy.getContentByTitle(title);
      if (content) {
        xmlBlocks.push(`<context_entry title="${title}">\n${content.trim()}\n</context_entry>`);
        newlyLoadedTitles.push(title);
      }
    }

    return {
      formattedContext: xmlBlocks.join('\n\n'),
      newlyLoadedTitles
    };
  }
}

export const contextService = new ContextService();
