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

    // 1. Mandatorily match eager-loaded entries for the first turn
    // Profile of the sender, Session with sender, Family notes, and Profile of Yasmin
    const profileOfSenderTitle = `Profile of ${username}`;
    const sessionWithSenderTitle = `Session with ${username}`;
    const familyNotesTitle = 'Family notes';
    const profileOfYasminTitle = 'Profile of Yasmin';

    const matchedProfileSender = titles.find(t => t.toLowerCase() === profileOfSenderTitle.toLowerCase());
    const matchedSessionSender = titles.find(t => t.toLowerCase() === sessionWithSenderTitle.toLowerCase());
    const matchedFamilyNotes = titles.find(t => t.toLowerCase() === familyNotesTitle.toLowerCase());
    const matchedProfileYasmin = titles.find(t => t.toLowerCase() === profileOfYasminTitle.toLowerCase());

    // Identify candidate titles for injection
    const candidateTitles: string[] = [];
    if (matchedProfileYasmin && !loadedSet.has(matchedProfileYasmin)) {
      candidateTitles.push(matchedProfileYasmin);
    }
    if (matchedFamilyNotes && !loadedSet.has(matchedFamilyNotes)) {
      candidateTitles.push(matchedFamilyNotes);
    }
    if (matchedProfileSender && !loadedSet.has(matchedProfileSender)) {
      candidateTitles.push(matchedProfileSender);
    }
    if (matchedSessionSender && !loadedSet.has(matchedSessionSender)) {
      candidateTitles.push(matchedSessionSender);
    }

    // 2. Load actual contents and format as clean XML
    const xmlBlocks: string[] = [];
    const newlyLoadedTitles: string[] = [];

    for (const title of candidateTitles) {
      const content = await dbProxy.getContentByTitle(title);
      if (content !== null && content !== undefined) {
        xmlBlocks.push(`<context_entry title="${title}">\n${content.trim()}\n</context_entry>`);
        newlyLoadedTitles.push(title);
      }
    }

    let formattedContext = xmlBlocks.join('\n\n');

    // Identify the user Yasmin is talking to
    formattedContext += `\n\nYou are talking to ${username}.`;

    // 3. On the initial turn, inject the manifest of all other available titles
    if (loadedSet.size === 0) {
      const allTitles = await dbProxy.getAllTitles();
      const eagerlyLoadedSet = new Set(candidateTitles.map(t => t.toLowerCase()));
      const availableTitles = allTitles.filter(t => !eagerlyLoadedSet.has(t.toLowerCase()));

      if (availableTitles.length > 0) {
        const titleListXml = `<available_context_entries>\n${availableTitles
          .map(t => `- ${t}`)
          .join('\n')}\n</available_context_entries>`;
        formattedContext = formattedContext ? `${titleListXml}\n\n${formattedContext}` : titleListXml;
      }
    }

    return {
      formattedContext,
      newlyLoadedTitles
    };
  }
}

export const contextService = new ContextService();
