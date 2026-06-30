import { dbProxy } from '../database/db_proxy';
import { tfIdfService } from './tfidf.service';

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
    const titles = await dbProxy.getAllTitles();

    // 1. Mandatorily match sender background (case-insensitive)
    const userBackgroundTitle = `background on ${username.toLowerCase()}`;
    const matchedUserTitle = titles.find(t => t.toLowerCase() === userBackgroundTitle);

    // 2. Query matching using TF-IDF on the other titles
    const otherTitles = titles.filter(t => t.toLowerCase() !== userBackgroundTitle);
    const tfidfMatches = tfIdfService.matchTitles(prompt, otherTitles, 2);

    // Identify candidate titles for injection
    const candidateTitles: string[] = [];
    if (matchedUserTitle && !loadedSet.has(matchedUserTitle)) {
      candidateTitles.push(matchedUserTitle);
    }

    for (const match of tfidfMatches) {
      if (!loadedSet.has(match.title)) {
        candidateTitles.push(match.title);
      }
    }

    // Fallback: if no matches and sender's background is not loaded yet, try fuzzy match on username
    if (candidateTitles.length === 0 && !loadedSet.has(userBackgroundTitle)) {
      const fallbackTitle = titles.find(
        t => t.toLowerCase().includes(username.toLowerCase()) && !loadedSet.has(t)
      );
      if (fallbackTitle) {
        candidateTitles.push(fallbackTitle);
      }
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
