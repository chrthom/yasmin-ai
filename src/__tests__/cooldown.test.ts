jest.mock('../config', () => ({
  config: {
    mistral: {
      requestTimeoutMs: 120000
    },
    nightly: {
      tz: 'Europe/Berlin'
    }
  }
}));

import { MemoryArchiveRow } from '../database/models/memory_archive.model';
import {
  COOLDOWN_ACTIVE_DAYS,
  extractConversationUserDates,
  extractPersonActiveChatDates,
  formatActiveChatDatesForPrompt,
  formatCooldownDate,
  parseJournalChatDates,
  stampJournalChatDates,
  stripJournalChatDates
} from '../nightly/cooldown';

function archiveRow(filePath: string, content: string, createdAt: Date): MemoryArchiveRow {
  return {
    id: 1,
    filePath,
    content,
    contentHash: 'hash',
    version: 1,
    mistralDocId: null,
    syncedAt: null,
    createdAt
  };
}

describe('cooldown', () => {
  describe('formatCooldownDate', () => {
    it('formats instants in MEMORY_TZ (Europe/Berlin) rather than UTC', () => {
      // 2026-10-05T22:30:00Z is 2026-10-06 00:30 CEST in Berlin.
      expect(formatCooldownDate(new Date('2026-10-05T22:30:00Z'))).toBe('2026-10-06');
      expect(formatCooldownDate(new Date('2026-01-15T12:00:00Z'))).toBe('2026-01-15');
    });
  });

  describe('extractConversationUserDates & journal chatDates helpers', () => {
    it('extracts sorted distinct user-message dates in MEMORY_TZ and ignores assistant/tool rows', () => {
      const dates = extractConversationUserDates([
        // 2026-10-05 23:30 CEST -> 2026-10-05
        { type: 'message.input', role: 'user', content: 'Hi', createdAt: '2026-10-05T21:30:00Z' },
        // Assistant reply after midnight Berlin time must NOT add an active user day on its own
        { type: 'message.output', role: 'assistant', content: 'Hey!', createdAt: '2026-10-05T22:05:00Z' },
        // Tool execution on another day must NOT count
        { type: 'function.call', content: '{}', createdAt: '2026-10-07T10:00:00Z' },
        // User follow-up next morning in Berlin -> 2026-10-06
        { type: 'message.input', role: 'user', content: 'Moin', createdAt: '2026-10-06T07:15:00Z' },
        // Second user message on 2026-10-05 (out of order) deduplicates cleanly
        { type: 'message.input', role: 'user', content: 'Nachtrag', createdAt: '2026-10-05T19:00:00Z' }
      ]);

      expect(dates).toEqual(['2026-10-05', '2026-10-06']);
    });

    it('falls back to conversation updatedAt only when non-empty messages carry no user timestamps', () => {
      expect(extractConversationUserDates([], '2026-10-05T12:00:00Z')).toEqual([]);
      expect(
        extractConversationUserDates(
          [{ type: 'message.input', role: 'user', content: 'Hi' }],
          '2026-10-05T22:30:00Z'
        )
      ).toEqual(['2026-10-06']);
    });

    it('stamps, parses, and strips chatDates headers idempotently', () => {
      const stamped = stampJournalChatDates('Zara erzählte vom Töpferkurs.', [
        '2026-10-06',
        '2026-10-05',
        '2026-10-06'
      ]);
      expect(stamped).toBe('chatDates: 2026-10-05, 2026-10-06\n\nZara erzählte vom Töpferkurs.');
      expect(parseJournalChatDates(stamped)).toEqual(['2026-10-05', '2026-10-06']);
      expect(stripJournalChatDates(stamped)).toBe('Zara erzählte vom Töpferkurs.');
      // Empty dates or empty body leave journalText untouched:
      expect(stampJournalChatDates('Zara erzählte vom Töpferkurs.', [])).toBe(
        'Zara erzählte vom Töpferkurs.'
      );
      expect(stampJournalChatDates('   ', ['2026-10-05'])).toBe('   ');
    });
  });

  describe('extractPersonActiveChatDates', () => {
    it('counts distinct active conversation dates strictly for the target person (including legacy rows without headers)', () => {
      const rows: MemoryArchiveRow[] = [
        // Two conversations for Zara on the same Berlin calendar day -> 1 active day
        archiveRow('journals/zara/conv-1.md', 'Journal 1', new Date('2026-10-05T09:00:00Z')),
        archiveRow('journals/zara/conv-2.md', 'Journal 2', new Date('2026-10-05T18:30:00Z')),
        // Another active day for Zara (late UTC -> next day in Berlin)
        archiveRow('journals/zara/conv-3.md', 'Journal 3', new Date('2026-10-07T22:30:00Z')),
        // Empty and header-only journal entries are ignored
        archiveRow('journals/zara/conv-empty.md', '   ', new Date('2026-10-09T12:00:00Z')),
        archiveRow(
          'journals/zara/conv-header-only.md',
          'chatDates: 2026-10-09\n\n   ',
          new Date('2026-10-09T12:00:00Z')
        ),
        // Other people's journals and dreams are ignored
        archiveRow('journals/christopher/conv-4.md', 'Dad chat', new Date('2026-10-06T12:00:00Z')),
        archiveRow('journals/dreams/2026-10-08.md', 'TRAUM', new Date('2026-10-08T22:00:00Z')),
        archiveRow('people/zara.md', 'Profile', new Date('2026-10-05T22:00:00Z'))
      ];

      const dates = extractPersonActiveChatDates(rows, 'zara');
      expect([...dates].sort()).toEqual(['2026-10-05', '2026-10-08']);
    });

    it('counts persisted chatDates across multi-day backlogs and multi-day chats instead of collapsing to row.createdAt', () => {
      // Simulate a backlog recovery run on 2026-10-10 where every journal row received the same collectedAt.
      const sameCollectedAt = new Date('2026-10-10T02:00:00Z');
      const rows: MemoryArchiveRow[] = [
        archiveRow(
          'journals/zara/conv-backlog-1.md',
          stampJournalChatDates('Montag & Dienstag Chat.', ['2026-10-05', '2026-10-06']),
          sameCollectedAt
        ),
        archiveRow(
          'journals/zara/conv-backlog-2.md',
          stampJournalChatDates('Donnerstag Chat.', ['2026-10-08']),
          sameCollectedAt
        ),
        archiveRow(
          'journals/zara/conv-backlog-3.md',
          stampJournalChatDates('Freitag Chat.', ['2026-10-09']),
          sameCollectedAt
        )
      ];

      const dates = extractPersonActiveChatDates(rows, 'zara');
      expect([...dates].sort()).toEqual(['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09']);
    });

    it('excludes dream files under journals/dreams/ while keeping real conv ids for a user named dreams', () => {
      const rows: MemoryArchiveRow[] = [
        archiveRow('journals/dreams/2026-10-08.md', 'TRAUM', new Date('2026-10-08T12:00:00Z')),
        archiveRow('journals/dreams/conv-abc.md', 'Real chat', new Date('2026-10-09T12:00:00Z'))
      ];

      const dates = extractPersonActiveChatDates(rows, 'dreams');
      expect([...dates]).toEqual(['2026-10-09']);
    });

    it('supports hyphenated multi-word slugs', () => {
      const rows: MemoryArchiveRow[] = [
        archiveRow('journals/mary-jane/conv-1.md', 'Chat', new Date('2026-10-05T12:00:00Z'))
      ];

      expect([...extractPersonActiveChatDates(rows, 'mary-jane')]).toEqual(['2026-10-05']);
    });
  });

  describe('formatActiveChatDatesForPrompt', () => {
    it('formats empty sets as "(none recorded yet)" and sorts/deduplicates up to 2 * COOLDOWN_ACTIVE_DAYS dates', () => {
      expect(COOLDOWN_ACTIVE_DAYS).toBe(5);
      expect(formatActiveChatDatesForPrompt([])).toBe('(none recorded yet)');
      expect(formatActiveChatDatesForPrompt(['2026-10-08', '2026-10-05', '2026-10-08'])).toBe(
        '2026-10-05, 2026-10-08'
      );
    });

    it('bounds long histories to the most recent 2 * COOLDOWN_ACTIVE_DAYS dates with an earlier-count note', () => {
      const twelveDates = Array.from({ length: 12 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
      expect(formatActiveChatDatesForPrompt(twelveDates)).toBe(
        '2026-10-03, 2026-10-04, 2026-10-05, 2026-10-06, 2026-10-07, 2026-10-08, 2026-10-09, 2026-10-10, 2026-10-11, 2026-10-12 (plus 2 earlier active chat days)'
      );
    });
  });
});
