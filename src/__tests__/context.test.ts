import { executeQuery } from '../database/connection';
import { contextService } from '../services/context.service';
import { TEST_CONTEXT_DATA } from './fixtures/context_data';

// Exercise the real model as well as the service so every database query is observable.
jest.mock('../database/connection', () => ({ executeQuery: jest.fn() }));

const mockExecuteQuery = executeQuery as jest.Mock;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-08T22:30:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('Context Service', () => {
  beforeEach(() => {
    mockExecuteQuery.mockReset().mockResolvedValue([TEST_CONTEXT_DATA]);
  });

  afterEach(() => {
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
    expect(mockExecuteQuery).toHaveBeenCalledWith('SELECT title, content FROM context_entries');
  });

  it('builds the first-turn manifest and eager blocks in their respective orders from one snapshot', async () => {
    mockExecuteQuery.mockResolvedValueOnce([
      [
        { title: 'Profile of Other', content: 'not eager' },
        { title: 'pRoFiLe Of ZaRa', content: '  Sender  \n' },
        { title: 'family NOTES', content: '   ' },
        { title: 'PROFILE OF YASMIN', content: '\nYasmin\n' },
        { title: 'Extra', content: 'also not eager' }
      ]
    ]);

    const result = await contextService.getRelevantContext('zara', []);

    expect(result).toEqual({
      formattedContext:
        '<available_context_entries>\n- Profile of Other\n- Extra\n</available_context_entries>\n\n' +
        '<context_entry title="PROFILE OF YASMIN">\nYasmin\n</context_entry>\n\n' +
        '<context_entry title="family NOTES">\n\n</context_entry>\n\n' +
        '<context_entry title="pRoFiLe Of ZaRa">\nSender\n</context_entry>\n\n' +
        'You are talking to zara. Today is 2026-10-09.',
      newlyLoadedTitles: ['PROFILE OF YASMIN', 'family NOTES', 'pRoFiLe Of ZaRa']
    });
  });

  it('only loads the eager profiles even when other profiles are available', async () => {
    const { formattedContext, newlyLoadedTitles } = await contextService.getRelevantContext(
      'christopher',
      []
    );
    expect(formattedContext).toContain('<context_entry title="Profile of Yasmin">');
    expect(formattedContext).toContain('<context_entry title="Profile of Christopher">');
    expect(formattedContext).toContain('<context_entry title="Family notes">');
    expect(formattedContext).not.toContain('<context_entry title="Profile of Samira">');
    expect(formattedContext).not.toContain('<context_entry title="Profile of Ellena">');
    expect(formattedContext).toContain('- Profile of Samira');
    expect(formattedContext).toContain('- Profile of Ellena');
    expect(newlyLoadedTitles).toEqual(['Profile of Yasmin', 'Family notes', 'Profile of Christopher']);
  });

  it('preserves duplicate Yasmin blocks and loaded titles when Yasmin is the sender', async () => {
    mockExecuteQuery.mockResolvedValueOnce([
      [
        { title: 'Profile of Yasmin', content: 'Yasmin' },
        { title: 'Family notes', content: '' }
      ]
    ]);

    expect(await contextService.getRelevantContext('yasmin', [])).toEqual({
      formattedContext:
        '<context_entry title="Profile of Yasmin">\nYasmin\n</context_entry>\n\n' +
        '<context_entry title="Family notes">\n\n</context_entry>\n\n' +
        '<context_entry title="Profile of Yasmin">\nYasmin\n</context_entry>\n\n' +
        'You are talking to yasmin. Today is 2026-10-09.',
      newlyLoadedTitles: ['Profile of Yasmin', 'Family notes', 'Profile of Yasmin']
    });
  });

  it('skips already loaded titles and includes today’s date in MEMORY_TZ on subsequent turns', async () => {
    const loaded = ['Profile of Christopher', 'Profile of Yasmin', 'Family notes'];
    expect(await contextService.getRelevantContext('christopher', loaded)).toEqual({
      formattedContext: '\n\nYou are talking to christopher. Today is 2026-10-09.',
      newlyLoadedTitles: []
    });
  });

  it('uses exact case-sensitive loaded-title checks for Set inputs', async () => {
    mockExecuteQuery.mockResolvedValueOnce([
      [
        { title: 'PROFILE OF YASMIN', content: 'Yasmin' },
        { title: 'Family notes', content: '' },
        { title: 'Profile of Zara', content: 'Zara' },
        { title: 'Other', content: 'Other' }
      ]
    ]);

    expect(
      await contextService.getRelevantContext('ZARA', new Set(['profile of yasmin', 'Family notes']))
    ).toEqual({
      formattedContext:
        '<context_entry title="PROFILE OF YASMIN">\nYasmin\n</context_entry>\n\n' +
        '<context_entry title="Profile of Zara">\nZara\n</context_entry>\n\n' +
        'You are talking to ZARA. Today is 2026-10-09.',
      newlyLoadedTitles: ['PROFILE OF YASMIN', 'Profile of Zara']
    });
  });

  it('omits missing and nullish contents but still loads empty content and excludes candidates from the manifest', async () => {
    mockExecuteQuery.mockResolvedValueOnce([
      [
        { title: 'Family notes', content: '' },
        { title: 'Profile of Yasmin', content: null },
        { title: 'Profile of Zara', content: undefined },
        { title: 'Other', content: 'content' }
      ]
    ]);

    expect(await contextService.getRelevantContext('zara', [])).toEqual({
      formattedContext:
        '<available_context_entries>\n- Other\n</available_context_entries>\n\n' +
        '<context_entry title="Family notes">\n\n</context_entry>\n\n' +
        'You are talking to zara. Today is 2026-10-09.',
      newlyLoadedTitles: ['Family notes']
    });
  });

  it('renders the manifest but no eager block for a missing sender and missing defaults', async () => {
    mockExecuteQuery.mockResolvedValueOnce([[{ title: 'Other', content: 'content' }]]);

    expect(await contextService.getRelevantContext('unknown', [])).toEqual({
      formattedContext:
        '<available_context_entries>\n- Other\n</available_context_entries>\n\n\n\nYou are talking to unknown. Today is 2026-10-09.',
      newlyLoadedTitles: []
    });
  });

  it('handles an empty snapshot', async () => {
    mockExecuteQuery.mockResolvedValueOnce([[]]);
    expect(await contextService.getRelevantContext('unknown', [])).toEqual({
      formattedContext: '\n\nYou are talking to unknown. Today is 2026-10-09.',
      newlyLoadedTitles: []
    });
  });

  it('propagates a snapshot query failure', async () => {
    const error = new Error('database unavailable');
    mockExecuteQuery.mockRejectedValueOnce(error);
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(contextService.getRelevantContext('zara', [])).rejects.toBe(error);
    } finally {
      log.mockRestore();
    }
  });
});

describe('context snapshots across turns', () => {
  it('fetches a fresh snapshot per turn while suppressing previously loaded titles', async () => {
    mockExecuteQuery
      .mockReset()
      .mockResolvedValueOnce([[{ title: 'Profile of Yasmin', content: 'old' }]])
      .mockResolvedValueOnce([
        [
          { title: 'Profile of Yasmin', content: 'updated' },
          { title: 'Family notes', content: 'new family notes' },
          { title: 'Profile of Zara', content: 'new profile' },
          { title: 'Other', content: 'not eager' }
        ]
      ]);

    const first = await contextService.getRelevantContext('zara', []);
    expect(first).toEqual({
      formattedContext:
        '<context_entry title="Profile of Yasmin">\nold\n</context_entry>\n\n' +
        'You are talking to zara. Today is 2026-10-09.',
      newlyLoadedTitles: ['Profile of Yasmin']
    });

    const second = await contextService.getRelevantContext('zara', first.newlyLoadedTitles);
    expect(second).toEqual({
      formattedContext:
        '<context_entry title="Family notes">\nnew family notes\n</context_entry>\n\n' +
        '<context_entry title="Profile of Zara">\nnew profile\n</context_entry>\n\n' +
        'You are talking to zara. Today is 2026-10-09.',
      newlyLoadedTitles: ['Family notes', 'Profile of Zara']
    });
    expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
    expect(mockExecuteQuery.mock.calls).toEqual([
      ['SELECT title, content FROM context_entries'],
      ['SELECT title, content FROM context_entries']
    ]);
  });
});
