import {
  ChatAgent,
  mockFetch,
  mockGetUndeliveredNotesForUser,
  mockClaimNoteDelivery,
  mockInsertIntradayNote,
  mockReleaseNoteDelivery,
  mockIsKnownPerson,
  setupChatAgent
} from './fixtures/chat_agent.fixture';

describe('ChatAgent', () => {
  let chatAgent: ChatAgent;

  beforeEach(() => {
    chatAgent = setupChatAgent();
  });

  describe('pending notes delivery (outbox)', () => {
    const okResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ outputs: [] })
    };

    it('injects claimed notes as a <nachrichten_fuer_dich> block before the user message', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue(undefined);
      mockGetUndeliveredNotesForUser.mockResolvedValue([
        { id: 1, fromUsername: 'christopher', content: 'Be home by 6 pm' },
        { id: 2, fromUsername: 'anjali', content: 'Dinner is ready at 7' }
      ]);
      mockFetch.mockResolvedValueOnce(okResponse);
      await chatAgent.processRequest('Hello', 'zara');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const promptContent = body.inputs[0].content;
      expect(promptContent).toContain('<nachrichten_fuer_dich>');
      expect(promptContent).toContain('Christopher wants me to tell you: Be home by 6 pm');
      expect(promptContent).toContain('Anjali wants me to tell you: Dinner is ready at 7');
      expect(promptContent).toContain('</nachrichten_fuer_dich>');
      // The block comes before the actual user message
      expect(promptContent.indexOf('<nachrichten_fuer_dich>')).toBeLessThan(promptContent.indexOf('Hello'));
      expect(mockClaimNoteDelivery).toHaveBeenCalledTimes(2);
      expect(mockClaimNoteDelivery).toHaveBeenNthCalledWith(1, 1, 'zara');
      expect(mockClaimNoteDelivery).toHaveBeenNthCalledWith(2, 2, 'zara');
    });

    it('concatenates multiple notes in chronological order inside one block', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue(undefined);
      mockGetUndeliveredNotesForUser.mockResolvedValue([
        { id: 1, fromUsername: 'christopher', content: 'first' },
        { id: 2, fromUsername: 'anjali', content: 'second' }
      ]);
      mockFetch.mockResolvedValueOnce(okResponse);
      await chatAgent.processRequest('Hi', 'zara');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const promptContent = body.inputs[0].content;
      const block = promptContent.slice(
        promptContent.indexOf('<nachrichten_fuer_dich>'),
        promptContent.indexOf('</nachrichten_fuer_dich>')
      );
      expect((block.match(/<nachrichten_fuer_dich>/g) || []).length).toBe(1);
      expect(block.indexOf('first')).toBeLessThan(block.indexOf('second'));
    });

    it('skips notes whose delivery claim lost the race (never delivers a note twice)', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue(undefined);
      mockGetUndeliveredNotesForUser.mockResolvedValue([
        { id: 1, fromUsername: 'christopher', content: 'lost race' },
        { id: 2, fromUsername: 'anjali', content: 'won race' }
      ]);
      mockClaimNoteDelivery.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      mockFetch.mockResolvedValueOnce(okResponse);
      await chatAgent.processRequest('Hello', 'zara');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const promptContent = body.inputs[0].content;
      expect(promptContent).toContain('won race');
      expect(promptContent).not.toContain('lost race');
    });

    it('injects no block when there is nothing to deliver', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue(undefined);
      mockGetUndeliveredNotesForUser.mockResolvedValue([]);
      mockFetch.mockResolvedValueOnce(okResponse);
      await chatAgent.processRequest('Hello', 'zara');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.inputs[0].content).not.toContain('<nachrichten_fuer_dich>');
    });

    it('passes claimed notes through to the respawned conversation (notes are not lost on 404)', async () => {
      jest
        .spyOn(chatAgent as any, 'getActiveConversationId')
        .mockResolvedValueOnce('conv-stale')
        .mockResolvedValue(undefined);
      mockGetUndeliveredNotesForUser.mockResolvedValue([
        { id: 3, fromUsername: 'anjali', content: 'Dinner at 7' }
      ]);
      // Resume attempt -> 404 (conversation deleted by the nightly job)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      });
      // Fresh-conversation attempt -> success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          conversation_id: 'conv-fresh',
          outputs: [{ type: 'message.output', content: 'Ok!' }]
        })
      });
      (chatAgent as any).conversationCache.set('zara', {
        conversationId: 'conv-stale',
        expiresAt: Date.now() + 100000,
        loadedContextTitles: [],
        turnCount: 0
      });
      const result = await chatAgent.processRequest('Hello', 'zara');
      expect(result).toHaveLength(1);
      // The respawned prompt carries the already-claimed notes block...
      const respawnBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(respawnBody.inputs[0].content).toContain('<nachrichten_fuer_dich>');
      expect(respawnBody.inputs[0].content).toContain('Anjali wants me to tell you: Dinner at 7');
      // ...and the notes were claimed exactly once, never re-claimed on the respawn
      expect(mockClaimNoteDelivery).toHaveBeenCalledTimes(1);
      expect(mockGetUndeliveredNotesForUser).toHaveBeenCalledTimes(1);
    });

    it('passes claimed notes through when the respawn is triggered by a failed tool request', async () => {
      jest
        .spyOn(chatAgent as any, 'getActiveConversationId')
        .mockResolvedValueOnce('conv-tool')
        .mockResolvedValue(undefined);
      mockGetUndeliveredNotesForUser.mockResolvedValue([
        { id: 4, fromUsername: 'christopher', content: 'Call me' }
      ]);
      // First turn -> a tool call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          conversation_id: 'conv-tool',
          outputs: [
            {
              type: 'message.tool_calls',
              tool_calls: [
                {
                  id: 'call-1',
                  function: { name: 'read_context_entry', arguments: '{"title":"Family notes"}' }
                }
              ]
            }
          ]
        })
      });
      // Tool-result request -> 400 (broken conversation)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request'
      });
      // Fresh-conversation respawn -> success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          conversation_id: 'conv-fresh',
          outputs: [{ type: 'message.output', content: 'Done' }]
        })
      });
      (chatAgent as any).conversationCache.set('zara', {
        conversationId: 'conv-tool',
        expiresAt: Date.now() + 100000,
        loadedContextTitles: [],
        turnCount: 0
      });
      const result = await chatAgent.processRequest('Hello', 'zara');
      expect(result).toHaveLength(1);
      const respawnBody = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(respawnBody.inputs[0].content).toContain('Christopher wants me to tell you: Call me');
      expect(mockClaimNoteDelivery).toHaveBeenCalledTimes(1);
    });

    it('releases the delivery claims when the request fails for a non-stale reason (HTTP 500)', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue('conv-123');
      mockGetUndeliveredNotesForUser.mockResolvedValue([
        { id: 3, fromUsername: 'anjali', content: 'Dinner at 7' }
      ]);
      // Non-stale failure: no respawn, the notes were never shown to the user. The 500 is
      // retried (safeRetry) with the default backoff before the turn finally fails.
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      });
      await expect(chatAgent.processRequest('Hello', 'zara')).rejects.toThrow(
        'Mistral API request failed: HTTP 500'
      );
      expect(mockClaimNoteDelivery).toHaveBeenCalledTimes(1);
      expect(mockReleaseNoteDelivery).toHaveBeenCalledTimes(1);
      expect(mockReleaseNoteDelivery).toHaveBeenCalledWith(3, 'zara');
    });

    it('releases the delivery claims when a FRESH conversation create hits a stale 400/404 (no respawn possible)', async () => {
      // Regression guard: a 400/404 on the conversation create itself can neither respawn
      // (there is no old conversation) nor deliver -- the claimed notes must be released so
      // they ride along with the next input instead of being orphaned.
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue(undefined);
      mockGetUndeliveredNotesForUser.mockResolvedValue([
        { id: 6, fromUsername: 'anjali', content: 'Dinner at 7' }
      ]);
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      });
      await expect(chatAgent.processRequest('Hello', 'zara')).rejects.toThrow('no respawn possible');
      expect(mockClaimNoteDelivery).toHaveBeenCalledTimes(1);
      expect(mockReleaseNoteDelivery).toHaveBeenCalledTimes(1);
      expect(mockReleaseNoteDelivery).toHaveBeenCalledWith(6, 'zara');
    });
    it('releases the delivery claims on a network error too', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue(undefined);
      mockGetUndeliveredNotesForUser.mockResolvedValue([
        { id: 4, fromUsername: 'christopher', content: 'Call me' }
      ]);
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      await expect(chatAgent.processRequest('Hello', 'zara')).rejects.toThrow('Network error');
      expect(mockReleaseNoteDelivery).toHaveBeenCalledWith(4, 'zara');
    });

    it('does NOT release claims on the respawn path (the respawn owns the claims)', async () => {
      jest
        .spyOn(chatAgent as any, 'getActiveConversationId')
        .mockResolvedValueOnce('conv-stale')
        .mockResolvedValue(undefined);
      mockGetUndeliveredNotesForUser.mockResolvedValue([
        { id: 5, fromUsername: 'anjali', content: 'Dinner at 7' }
      ]);
      // Stale 404 -> respawn; the respawned request succeeds
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found'
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            conversation_id: 'conv-fresh',
            outputs: [{ type: 'message.output', content: 'Ok!' }]
          })
        });
      (chatAgent as any).conversationCache.set('zara', {
        conversationId: 'conv-stale',
        expiresAt: Date.now() + 100000,
        loadedContextTitles: [],
        turnCount: 0
      });
      const result = await chatAgent.processRequest('Hello', 'zara');
      expect(result).toHaveLength(1);
      expect(mockReleaseNoteDelivery).not.toHaveBeenCalled();
    });

    it('keeps the chat working when the outbox read fails (note stays pending)', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue(undefined);
      mockGetUndeliveredNotesForUser.mockRejectedValue(new Error('db down'));
      mockFetch.mockResolvedValueOnce(okResponse);
      const result = await chatAgent.processRequest('Hello', 'zara');
      expect(result).toEqual([]);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.inputs[0].content).toContain('Hello');
    });
  });

  describe('share_note tool', () => {
    const toolCallResponse = (args: object) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        conversation_id: 'conv-tool',
        outputs: [
          {
            type: 'message.tool_calls',
            tool_calls: [
              {
                id: 'call-1',
                function: { name: 'share_note', arguments: JSON.stringify(args) }
              }
            ]
          }
        ]
      })
    });

    const toolResultResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ outputs: [{ type: 'message.output', content: 'Will do!' }] })
    };

    async function runShareNote(args: object, username = 'christopher') {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue('conv-tool');
      chatAgent['conversationCache'].set(username, {
        conversationId: 'conv-tool',
        expiresAt: Date.now() + 60_000,
        loadedContextTitles: [],
        turnCount: 0
      });
      mockFetch.mockResolvedValueOnce(toolCallResponse(args)).mockResolvedValueOnce(toolResultResponse);
      await chatAgent.processRequest('Tell Zara to be home by 6', username);
      const toolBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      return JSON.parse(toolBody.inputs[0].result);
    }

    it('stores a valid note for a known recipient and answers the tool call', async () => {
      mockInsertIntradayNote.mockResolvedValueOnce(11);
      const result = await runShareNote({ to: 'zara', content: 'Be home by 6 pm' });
      expect(result.success).toBe(true);
      expect(result.to).toBe('Zara');
      expect(mockInsertIntradayNote).toHaveBeenCalledWith('christopher', 'Zara', 'Be home by 6 pm');
    });

    it('stores an "everyone" note with a NULL recipient', async () => {
      mockInsertIntradayNote.mockResolvedValueOnce(12);
      const result = await runShareNote({ to: 'everyone', content: 'Family movie night' });
      expect(result.success).toBe(true);
      expect(result.to).toBe('everyone');
      expect(mockInsertIntradayNote).toHaveBeenCalledWith('christopher', null, 'Family movie night');
    });

    it('rejects an unknown recipient', async () => {
      mockIsKnownPerson.mockResolvedValueOnce(false);
      const result = await runShareNote({ to: 'stranger', content: 'hello' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown recipient');
      expect(mockInsertIntradayNote).not.toHaveBeenCalled();
    });

    it('accepts a recipient whose profile exists only in the database (DB-first lookup)', async () => {
      // A person the nightly integrate agent created a profile for -- one the static fixture
      // does not know ('Mira' has no entry there). isKnownPerson must consult
      // context_entries and recognize them; the mocked true stands in for that DB lookup.
      mockIsKnownPerson.mockResolvedValueOnce(true);
      const result = await runShareNote({ to: 'Mira', content: 'Welcome!' });
      expect(result.success).toBe(true);
      expect(result.to).toBe('Mira');
      expect(mockInsertIntradayNote).toHaveBeenCalledWith('christopher', 'Mira', 'Welcome!');
    });

    it('rejects empty content', async () => {
      const result = await runShareNote({ to: 'zara', content: '   ' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('non-empty');
      expect(mockInsertIntradayNote).not.toHaveBeenCalled();
    });

    it('rejects content over the 500 character cap', async () => {
      const result = await runShareNote({ to: 'zara', content: 'x'.repeat(501) });
      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
      expect(mockInsertIntradayNote).not.toHaveBeenCalled();
    });

    it('stores one note row per recipient when "to" is a comma-separated list of names', async () => {
      mockInsertIntradayNote.mockResolvedValueOnce(21).mockResolvedValueOnce(22);
      const result = await runShareNote({ to: 'zara, samira', content: 'Movie night at 8' });
      expect(result.success).toBe(true);
      expect(result.to).toBe('Zara, Samira');
      expect(result.ids).toEqual([21, 22]);
      expect(mockInsertIntradayNote).toHaveBeenCalledTimes(2);
      expect(mockInsertIntradayNote).toHaveBeenNthCalledWith(1, 'christopher', 'Zara', 'Movie night at 8');
      expect(mockInsertIntradayNote).toHaveBeenNthCalledWith(2, 'christopher', 'Samira', 'Movie night at 8');
    });

    it('rejects a recipient list containing an unknown person', async () => {
      mockIsKnownPerson.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const result = await runShareNote({ to: ['zara', 'stranger'], content: 'hello' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown recipient "Stranger"');
      expect(mockInsertIntradayNote).not.toHaveBeenCalled();
    });

    it('rejects an invalid "to" shape', async () => {
      const result = await runShareNote({ to: 42, content: 'hello' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('must be "everyone"');
      expect(mockInsertIntradayNote).not.toHaveBeenCalled();
    });

    it('rejects a "to" string that contains only commas/whitespace', async () => {
      const result = await runShareNote({ to: ' , , ', content: 'hello' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('at least one recipient');
      expect(mockInsertIntradayNote).not.toHaveBeenCalled();
    });

    it('answers with a failure result when the insert fails, without breaking the conversation', async () => {
      mockInsertIntradayNote.mockRejectedValueOnce(new Error('db down'));
      const result = await runShareNote({ to: 'zara', content: 'Be home by 6 pm' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to store the note');
    });
  });
});
