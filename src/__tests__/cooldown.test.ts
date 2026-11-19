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
  EMPTY_COOLDOWN_SECTION_PLACEHOLDER,
  applyPersonTopicCooldown,
  extractConversationUserDates,
  extractPersonActiveChatDates,
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

function samplePersonProfile(overrides?: {
  ideas?: string;
  happenings?: string;
  openTopics?: string;
  intentions?: string;
}): string {
  return [
    '## Core Facts',
    '- Zara ist Yasmins ältere Schwester.',
    '',
    '## Current Attitude',
    '- Entspannt und gut gelaunt.',
    '',
    '## Ideas, Interests & Goals',
    overrides?.ideas ?? '- Töpferkurs in Altona (besprochen am 2026-10-05)\n- Liest gerne Science-Fiction',
    '',
    '## Recent Happenings',
    overrides?.happenings ?? '- Am 2026-10-05 hat Zara von ihrer neuen Schale erzählt.',
    '',
    '## Open Topics',
    overrides?.openTopics ??
      '- Neue Glasur beim Töpferkurs (besprochen am 2026-10-05)\n- Geschenkidee für Papa',
    '',
    '## Communication Style',
    '- Locker, direkt, gerne mit trockenem Humor.',
    '',
    "## Yasmin's View",
    '- Meine Einschätzung (Konfidenz: mittel, Tendenz: stable): Zara ist kreativ und verlässlich.',
    '',
    "## Yasmin's Intentions",
    overrides?.intentions ??
      '- Nach dem Töpferkurs fragen (Status: open, besprochen am 2026-10-05)\n- Ihr einen Sci-Fi-Roman vorschlagen (Status: open)'
  ].join('\n');
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

  describe('applyPersonTopicCooldown', () => {
    it('returns content byte-identically when no besprochen-am marker is present', () => {
      const plain = '## Core Facts\n- Mag Katzen.\n\n## Open Topics\n- Neues Fahrrad\n';
      expect(applyPersonTopicCooldown(plain, new Set(['2026-10-05']), '2026-10-10')).toBe(plain);
    });

    it('at 0 subsequent active days (even weeks later on the calendar): strips from Open Topics & Intentions and marks Pause in Ideas', () => {
      const input = samplePersonProfile();
      // Zara last chatted on 2026-10-05; today is 2026-10-20, but Zara had 0 chats since 2026-10-05.
      const result = applyPersonTopicCooldown(input, new Set(['2026-10-05']), '2026-10-20');

      expect(result).toContain(
        '- Töpferkurs in Altona (zuletzt im letzten Gespräch besprochen – Pause, nicht von selbst anfangen außer bei neuem Aspekt)'
      );
      expect(result).toContain('- Liest gerne Science-Fiction');
      // Stripped from both Open Topics and Yasmin's Intentions:
      expect(result).not.toContain('Neue Glasur beim Töpferkurs');
      expect(result).not.toContain('Nach dem Töpferkurs fragen');
      // Unrelated open topics and intentions survive:
      expect(result).toContain('- Geschenkidee für Papa');
      expect(result).toContain('- Ihr einen Sci-Fi-Roman vorschlagen (Status: open)');
      // Recent Happenings stays untouched:
      expect(result).toContain('- Am 2026-10-05 hat Zara von ihrer neuen Schale erzählt.');
    });

    it('inserts the empty-section placeholder when cooldown strips every item in Open Topics or Intentions', () => {
      const input = samplePersonProfile({
        openTopics: '- Neue Glasur beim Töpferkurs (besprochen am 2026-10-05)',
        intentions: '- Nach dem Töpferkurs fragen (besprochen am 2026-10-05)'
      });

      const result = applyPersonTopicCooldown(input, new Set(['2026-10-05']), '2026-10-06');

      expect(result).toContain(`## Open Topics\n${EMPTY_COOLDOWN_SECTION_PLACEHOLDER}`);
      expect(result).toContain(`## Yasmin's Intentions\n${EMPTY_COOLDOWN_SECTION_PLACEHOLDER}`);
    });

    it('at 1 subsequent active day: uses singular "vor 1 Gesprächstag", keeps Open Topics with restraint, still strips Intentions', () => {
      const input = samplePersonProfile();
      const activeDates = new Set(['2026-10-05', '2026-10-08']);

      const result = applyPersonTopicCooldown(input, activeDates, '2026-10-08');

      expect(result).toContain(
        '- Töpferkurs in Altona (vor 1 Gesprächstag besprochen – Zurückhaltung, nur bei neuem Aspekt)'
      );
      expect(result).toContain(
        '- Neue Glasur beim Töpferkurs (vor 1 Gesprächstag besprochen – Zurückhaltung, nur bei neuem Aspekt)'
      );
      expect(result).not.toContain('Nach dem Töpferkurs fragen');
    });

    it('at 2..4 subsequent active days: uses plural "vor N Gesprächstagen" and still strips Intentions', () => {
      const input = samplePersonProfile();
      const activeDates = new Set(['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-11', '2026-10-14']);

      const result = applyPersonTopicCooldown(input, activeDates, '2026-10-14');

      expect(COOLDOWN_ACTIVE_DAYS).toBe(5);
      expect(result).toContain(
        '- Töpferkurs in Altona (vor 4 Gesprächstagen besprochen – Zurückhaltung, nur bei neuem Aspekt)'
      );
      expect(result).toContain(
        '- Neue Glasur beim Töpferkurs (vor 4 Gesprächstagen besprochen – Zurückhaltung, nur bei neuem Aspekt)'
      );
      expect(result).not.toContain('Nach dem Töpferkurs fragen');
    });

    it('at >= 5 subsequent active days: lifts cooldown in all sections and rewrites tag to "(am YYYY-MM-DD)"', () => {
      const input = samplePersonProfile();
      const activeDates = new Set([
        '2026-10-05',
        '2026-10-06',
        '2026-10-07',
        '2026-10-08',
        '2026-10-09',
        '2026-10-10'
      ]);

      const result = applyPersonTopicCooldown(input, activeDates, '2026-10-10');

      expect(result).toContain('- Töpferkurs in Altona (am 2026-10-05)');
      expect(result).toContain('- Neue Glasur beim Töpferkurs (am 2026-10-05)');
      expect(result).toContain('- Nach dem Töpferkurs fragen (Status: open, am 2026-10-05)');
      expect(result).not.toContain('Pause');
      expect(result).not.toContain('Zurückhaltung');
    });

    it('override 1 (neuer Aspekt >= besprochen date): keeps bullet intact across all sections even at 0 active days', () => {
      const input = samplePersonProfile({
        openTopics:
          '- Töpferkurs (besprochen am 2026-10-05) (neuer Aspekt am 2026-10-06: Mama (Anjali) möchte auch mitkommen)',
        intentions:
          '- Zara erzählen, dass Mama mit zum Töpferkurs will (besprochen am 2026-10-05, neuer Aspekt am 2026-10-06: Anjali fragte danach)'
      });

      const result = applyPersonTopicCooldown(input, new Set(['2026-10-05']), '2026-10-06');

      expect(result).toContain(
        '- Töpferkurs (besprochen am 2026-10-05) (neuer Aspekt am 2026-10-06: Mama (Anjali) möchte auch mitkommen)'
      );
      expect(result).toContain(
        '- Zara erzählen, dass Mama mit zum Töpferkurs will (besprochen am 2026-10-05, neuer Aspekt am 2026-10-06: Anjali fragte danach)'
      );
    });

    it('stale neuer Aspekt (< besprochen date) does NOT override cooldown and is cleaned up from rewritten bullets', () => {
      const input = samplePersonProfile({
        ideas:
          '- Töpferkurs (besprochen am 2026-10-08) (neuer Aspekt am 2026-10-06: Mama (Anjali) wollte mitkommen)',
        openTopics: '- Ausflug (neuer Aspekt am 2026-10-06: Papa (Chris) fragte, besprochen am 2026-10-07)',
        intentions:
          '- Nach Töpferkurs fragen (besprochen am 2026-10-08, neuer Aspekt am 2026-10-06: erledigt)'
      });

      const result = applyPersonTopicCooldown(
        input,
        new Set(['2026-10-05', '2026-10-07', '2026-10-08']),
        '2026-10-08'
      );

      expect(result).toContain(
        '- Töpferkurs (zuletzt im letzten Gespräch besprochen – Pause, nicht von selbst anfangen außer bei neuem Aspekt)'
      );
      expect(result).toContain(
        '- Ausflug (vor 1 Gesprächstag besprochen – Zurückhaltung, nur bei neuem Aspekt)'
      );
      expect(result).not.toContain('neuer Aspekt am 2026-10-06');
      expect(result).not.toContain('Anjali');
      expect(result).not.toContain('Nach Töpferkurs fragen');
    });

    it('override 2 (fällig ab): retains future deadlines with date-gated restraint, lifts once dueDate <= runDate, and strips pre-discussion deadlines', () => {
      const input = samplePersonProfile({
        openTopics: '- Mathe-Klausur am Freitag (besprochen am 2026-10-05) (fällig ab 2026-10-09)',
        intentions:
          '- Fragen wie die Mathe-Klausur lief (besprochen am 2026-10-05, fällig ab 2026-10-09)\n' +
          '- Alte Frist schon besprochen (besprochen am 2026-10-05, fällig ab 2026-10-03)'
      });

      // Before due date (2026-10-07): future fällig-ab items stay in the eager cache with explicit
      // date-gated restraint so quiet nights cannot strand the follow-up; stale pre-discussion
      // deadline (2026-10-03 <= 2026-10-05) is still stripped by cooldown.
      const beforeDue = applyPersonTopicCooldown(input, new Set(['2026-10-05']), '2026-10-07');
      expect(beforeDue).toContain(
        '- Mathe-Klausur am Freitag (am 2026-10-05 besprochen – Zurückhaltung bis 2026-10-09, erst ab Fälligkeit oder bei neuem Aspekt von selbst ansprechen) (fällig ab 2026-10-09)'
      );
      expect(beforeDue).toContain(
        '- Fragen wie die Mathe-Klausur lief (am 2026-10-05 besprochen – Zurückhaltung bis 2026-10-09, erst ab Fälligkeit oder bei neuem Aspekt von selbst ansprechen, fällig ab 2026-10-09)'
      );
      expect(beforeDue).not.toContain('Alte Frist schon besprochen');

      // On due date (2026-10-09): restraint lifts completely, stale 2026-10-03 deadline stays stripped.
      const onDue = applyPersonTopicCooldown(input, new Set(['2026-10-05']), '2026-10-09');
      expect(onDue).toContain('- Mathe-Klausur am Freitag (besprochen am 2026-10-05) (fällig ab 2026-10-09)');
      expect(onDue).toContain(
        '- Fragen wie die Mathe-Klausur lief (besprochen am 2026-10-05, fällig ab 2026-10-09)'
      );
      expect(onDue).not.toContain('Zurückhaltung bis 2026-10-09');
      expect(onDue).not.toContain('Alte Frist schon besprochen');
    });

    it.each([
      '(besprochen am 2026-10-08) (fällig ab 2026-10-03)',
      '(besprochen am 2026-10-08, fällig ab 2026-10-03)',
      '(fällig ab 2026-10-03, besprochen am 2026-10-08)',
      '(Status: open; fällig ab 2026-10-03; besprochen am 2026-10-08)',
      '(besprochen am 2026-10-08, fällig ab 2026-10-08)',
      '(besprochen am 2026-10-08) – fällig ab 2026-10-03'
    ])('removes stale live-chat deadline overrides from retained cooldown items: %s', tags => {
      const input = samplePersonProfile({
        ideas: `- Projekt ${tags}`,
        openTopics: `- Nach dem Projekt fragen ${tags}`
      });

      for (const days of [1, 2, 3, 4, 5]) {
        const dates = new Set(
          Array.from({ length: days + 1 }, (_, i) => `2026-10-${String(8 + i).padStart(2, '0')}`)
        );
        const result = applyPersonTopicCooldown(input, dates, '2026-10-20');
        expect(result).toContain('- Projekt');
        expect(result).toContain('- Nach dem Projekt fragen');
        expect(result).not.toContain('fällig ab');
        if (days < COOLDOWN_ACTIVE_DAYS) {
          expect(result).toContain('Zurückhaltung, nur bei neuem Aspekt');
        }
        expect(result).not.toContain('(,');
        expect(result).not.toContain(', )');
      }
    });

    it('cleans stale deadlines even when a fresh aspect or valid reached deadline retains the item', () => {
      const input = samplePersonProfile({
        openTopics:
          '- Projekt (besprochen am 2026-10-08, fällig ab 2026-10-03) ' +
          '(neuer Aspekt am 2026-10-09: neues Angebot)',
        intentions:
          '- Projekt fragen (besprochen am 2026-10-08, fällig ab 2026-10-08) ' + '(fällig ab 2026-10-10)'
      });
      const result = applyPersonTopicCooldown(input, new Set(['2026-10-08']), '2026-10-10');
      expect(result).toContain('- Projekt (besprochen am 2026-10-08)');
      expect(result).toContain('(neuer Aspekt am 2026-10-09: neues Angebot)');
      expect(result).toContain('- Projekt fragen (besprochen am 2026-10-08) (fällig ab 2026-10-10)');
      expect(result).not.toContain('fällig ab 2026-10-03');
      expect(result).not.toContain('fällig ab 2026-10-08');
    });

    it('keeps valid future deadlines while removing stale sibling deadline clauses', () => {
      const input =
        "## Yasmin's Intentions\n" +
        '- Projekt fragen (fällig ab 2026-10-03, besprochen am 2026-10-08, fällig ab 2026-10-12)';
      const result = applyPersonTopicCooldown(input, new Set(['2026-10-08']), '2026-10-09');
      expect(result).toContain('Zurückhaltung bis 2026-10-12');
      expect(result).toContain('fällig ab 2026-10-12');
      expect(result).not.toContain('fällig ab 2026-10-03');
    });

    it('strips multi-line bullets and blank-separated indented continuations / nested sub-bullets without leaving orphans', () => {
      const input = samplePersonProfile({
        openTopics: [
          '- Töpferkurs in Altona (zuletzt besprochen am 2026-10-05)',
          '',
          '  Sie probiert nächste Woche eine blaue Glasur aus.',
          '',
          '  - Foto zeigen lassen',
          '    - Auch die Schale von letzter Woche',
          '',
          '- Sommerurlaub in Italien'
        ].join('\n'),
        intentions: [
          '- Nach dem Töpferkurs fragen (besprochen am 2026-10-05)',
          '',
          '  - Foto der Glasur zeigen lassen'
        ].join('\n')
      });

      const stripped = applyPersonTopicCooldown(input, new Set(['2026-10-05']), '2026-10-05');

      expect(stripped).not.toContain('blaue Glasur');
      expect(stripped).not.toContain('Foto zeigen lassen');
      expect(stripped).not.toContain('Schale von letzter Woche');
      expect(stripped).not.toContain('Foto der Glasur');
      expect(stripped).toContain('- Sommerurlaub in Italien');
      expect(stripped).toContain(`## Yasmin's Intentions\n${EMPTY_COOLDOWN_SECTION_PLACEHOLDER}`);

      // When kept at 1 subsequent active day in Open Topics, blank-separated children stay attached and intact:
      const kept = applyPersonTopicCooldown(input, new Set(['2026-10-05', '2026-10-08']), '2026-10-08');
      expect(kept).toContain(
        [
          '- Töpferkurs in Altona (vor 1 Gesprächstag besprochen – Zurückhaltung, nur bei neuem Aspekt)',
          '',
          '  Sie probiert nächste Woche eine blaue Glasur aus.',
          '',
          '  - Foto zeigen lassen',
          '    - Auch die Schale von letzter Woche',
          '',
          '- Sommerurlaub in Italien'
        ].join('\n')
      );
      // In Intentions at 1 subsequent active day, parent + blank-separated sub-bullet are still stripped cleanly:
      expect(kept).not.toContain('Foto der Glasur');
    });
  });
});
