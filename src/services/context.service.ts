import { config } from '../config';
import { ContextEntry, getAllEntriesFromDb } from '../database/models/context.model';
import { contextEntryBlock, xmlBlock } from '../protocol';
import { profileTitle } from '../strings';

/** The result of one context-retrieval turn: the XML to inject and what it added. */
export interface ContextRetrievalResult {
  formattedContext: string;
  newlyLoadedTitles: string[];
}

/**
 * Service to select eager context from a database snapshot and format it as XML.
 */
export class ContextService {
  /**
   * Retrieves relevant context for a specific conversation turn, filtering out already loaded blocks
   * @param username The sender username
   * @param loadedTitles Set of titles that have already been loaded/sent in this conversation
   * @returns ContextRetrievalResult containing formatted XML context and any newly loaded titles
   * @throws The underlying error when the context_entries queries fail.
   */
  public async getRelevantContext(
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

    const matchedProfileSender = entries.find(
      e => e.title.toLowerCase() === profileOfSenderTitle.toLowerCase()
    );
    const matchedFamilyNotes = entries.find(e => e.title.toLowerCase() === familyNotesTitle.toLowerCase());
    const matchedProfileYasmin = entries.find(
      e => e.title.toLowerCase() === profileOfYasminTitle.toLowerCase()
    );

    // Identify candidates in injection order; the sender may also be Yasmin.
    const candidates: ContextEntry[] = [];
    if (matchedProfileYasmin && !loadedSet.has(matchedProfileYasmin.title)) {
      candidates.push(matchedProfileYasmin);
    }
    if (matchedFamilyNotes && !loadedSet.has(matchedFamilyNotes.title)) {
      candidates.push(matchedFamilyNotes);
    }
    if (matchedProfileSender && !loadedSet.has(matchedProfileSender.title)) {
      candidates.push(matchedProfileSender);
    }

    const xmlBlocks: string[] = [];
    const newlyLoadedTitles: string[] = [];

    for (const { title, content } of candidates) {
      if (content !== null && content !== undefined) {
        xmlBlocks.push(contextEntryBlock(title, content.trim()));
        newlyLoadedTitles.push(title);
      }
    }

    let formattedContext = xmlBlocks.join('\n\n');

    formattedContext += `\n\nYou are talking to ${username}.`;

    // Only the initial turn needs the manifest for lazy loading.
    if (loadedSet.size === 0) {
      const eagerlyLoadedSet = new Set(candidates.map(e => e.title.toLowerCase()));
      const availableTitles = titles.filter(t => !eagerlyLoadedSet.has(t.toLowerCase()));

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
