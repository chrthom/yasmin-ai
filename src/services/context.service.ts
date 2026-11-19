import { config } from '../config';
import {
  getAllEntriesFromDb,
  getAllTitlesFromDb,
  getContentByTitleFromDb
} from '../database/models/context.model';
import { contextEntryBlock, xmlBlock } from '../protocol';
import { profileTitle } from '../strings';

/** The result of one context-retrieval turn: the XML to inject and what it added. */
export interface ContextRetrievalResult {
  formattedContext: string;
  newlyLoadedTitles: string[];
}

/**
 * Service to load eager context entries and format them for injection.
 */
export class ContextService {
  /**
   * Retrieves relevant context for a specific conversation turn, filtering out already loaded blocks
   * @param prompt The incoming user prompt/message
   * @param username The sender username
   * @param loadedTitles Set of titles that have already been loaded/sent in this conversation
   * @returns ContextRetrievalResult containing formatted XML context and any newly loaded titles
   * @throws The underlying error when the context_entries queries fail.
   */
  public async getRelevantContext(
    prompt: string,
    username: string,
    loadedTitles: Set<string> | string[]
  ): Promise<ContextRetrievalResult> {
    const loadedSet = loadedTitles instanceof Set ? loadedTitles : new Set(loadedTitles);
    const entries = await getAllEntriesFromDb();
    const titles = entries.map(e => e.title);

    // Match the sender's profile, family notes and Yasmin's profile case-insensitively.
    const profileOfSenderTitle = profileTitle(username);
    const familyNotesTitle = config.context.familyNotesTitle;
    const profileOfYasminTitle = config.context.profileOfYasminTitle;

    const matchedProfileSender = titles.find(t => t.toLowerCase() === profileOfSenderTitle.toLowerCase());
    const matchedFamilyNotes = titles.find(t => t.toLowerCase() === familyNotesTitle.toLowerCase());
    const matchedProfileYasmin = titles.find(t => t.toLowerCase() === profileOfYasminTitle.toLowerCase());

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

    const xmlBlocks: string[] = [];
    const newlyLoadedTitles: string[] = [];

    for (const title of candidateTitles) {
      const content = await getContentByTitleFromDb(title);
      if (content !== null && content !== undefined) {
        xmlBlocks.push(contextEntryBlock(title, content.trim()));
        newlyLoadedTitles.push(title);
      }
    }

    let formattedContext = xmlBlocks.join('\n\n');

    formattedContext += `\n\nYou are talking to ${username}.`;

    // Only the initial turn needs the manifest for lazy loading.
    if (loadedSet.size === 0) {
      const allTitles = await getAllTitlesFromDb();
      const eagerlyLoadedSet = new Set(candidateTitles.map(t => t.toLowerCase()));
      const availableTitles = allTitles.filter(t => !eagerlyLoadedSet.has(t.toLowerCase()));

      if (availableTitles.length > 0) {
        const titleListXml = xmlBlock(
          'available_context_entries',
          availableTitles.map(t => `- ${t}`).join('\n')
        );
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
