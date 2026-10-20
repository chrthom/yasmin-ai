jest.mock('../database/models/context.model', () => ({
  listContextEntries: jest.fn()
}));

jest.mock('../database/models/memory_archive.model', () => ({
  insertNextVersion: jest.fn(),
  markSynced: jest.fn()
}));

jest.mock('../mistral/mistral_api', () => ({
  uploadDocument: jest.fn()
}));
jest.mock('../config', () => ({
  validateEnv: jest.fn(),
  config: {
    context: {
      familyNotesTitle: 'Family notes',
      profileOfYasminTitle: 'Profile of Yasmin'
    }
  }
}));

import { listContextEntries } from '../database/models/context.model';
import { insertNextVersion, markSynced } from '../database/models/memory_archive.model';
import { uploadDocument } from '../mistral/mistral_api';
import { bootstrapMemory } from '../../scripts/bootstrap-memory';

const mockListContextEntries = listContextEntries as jest.Mock;
const mockInsertNextVersion = insertNextVersion as jest.Mock;
const mockMarkSynced = markSynced as jest.Mock;
const mockUploadDocument = uploadDocument as jest.Mock;

function archiveRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 1,
    filePath: 'people/christopher.md',
    content: '',
    contentHash: 'hash',
    version: 1,
    mistralDocId: null,
    syncedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides
  };
}

describe('bootstrapMemory', () => {
  beforeEach(() => {
    mockListContextEntries.mockReset();
    mockInsertNextVersion.mockReset();
    mockMarkSynced.mockReset();
    mockUploadDocument.mockReset();

    // Default: every insert is treated as newly created, uploads succeed with a doc id derived
    // from the path so individual tests can assert markSynced was called with the right id.
    mockInsertNextVersion.mockImplementation(async (filePath: string, content: string) => ({
      row: archiveRow({ filePath, content, id: filePath.length }),
      created: true
    }));
    mockUploadDocument.mockImplementation(async (path: string) => ({ id: 'doc-' + path, path }));
  });

  it('seeds a Profile of X + Session with X pair into a fully populated people/<name>.md template', async () => {
    mockListContextEntries.mockResolvedValue([
      { title: 'Profile of Christopher', content: 'Loves hiking.' },
      { title: 'Session with Christopher', content: 'Talked about the weekend trip.' }
    ]);

    await bootstrapMemory();

    expect(mockInsertNextVersion).toHaveBeenCalledTimes(1);
    const [path, content] = mockInsertNextVersion.mock.calls[0];
    expect(path).toBe('people/christopher.md');
    expect(content).toBe(
      '## Core Facts\n' +
        '\n' +
        'Loves hiking.\n' +
        '\n' +
        '## Current Attitude\n' +
        '\n' +
        '## Ideas, Interests & Goals\n' +
        '\n' +
        '## Recent Happenings\n' +
        '\n' +
        '## Open Topics\n' +
        '\n' +
        'Talked about the weekend trip.\n' +
        '\n' +
        '## Communication Style\n' +
        '\n' +
        "## Yasmin's View\n" +
        '\n' +
        "## Yasmin's Intentions"
    );

    expect(mockUploadDocument).toHaveBeenCalledWith('people/christopher.md', content);
    expect(mockMarkSynced).toHaveBeenCalledWith(expect.any(Number), 'doc-people/christopher.md');
  });

  it('leaves Open Topics empty (no placeholder) when there is no matching Session with X', async () => {
    mockListContextEntries.mockResolvedValue([{ title: 'Profile of Mary', content: 'Works as a teacher.' }]);

    await bootstrapMemory();

    expect(mockInsertNextVersion).toHaveBeenCalledTimes(1);
    const [path, content] = mockInsertNextVersion.mock.calls[0];
    expect(path).toBe('people/mary.md');
    expect(content).toBe(
      '## Core Facts\n' +
        '\n' +
        'Works as a teacher.\n' +
        '\n' +
        '## Current Attitude\n' +
        '\n' +
        '## Ideas, Interests & Goals\n' +
        '\n' +
        '## Recent Happenings\n' +
        '\n' +
        '## Open Topics\n' +
        '\n' +
        '## Communication Style\n' +
        '\n' +
        "## Yasmin's View\n" +
        '\n' +
        "## Yasmin's Intentions"
    );
    expect(content).not.toMatch(/none|n\/a|empty/i);
  });

  it('treats an existing but empty Session with X the same as a missing one', async () => {
    mockListContextEntries.mockResolvedValue([
      { title: 'Profile of Mary', content: 'Works as a teacher.' },
      { title: 'Session with Mary', content: '' }
    ]);

    await bootstrapMemory();

    const [, content] = mockInsertNextVersion.mock.calls[0];
    expect(content).toContain(
      "## Open Topics\n\n## Communication Style\n\n## Yasmin's View\n\n## Yasmin's Intentions"
    );
  });

  it('seeds Profile of Yasmin verbatim to self-reflection/profile.md', async () => {
    mockListContextEntries.mockResolvedValue([
      { title: 'Profile of Yasmin', content: 'Yasmin is thoughtful and curious.' }
    ]);

    await bootstrapMemory();

    expect(mockInsertNextVersion).toHaveBeenCalledWith(
      'self-reflection/profile.md',
      'Yasmin is thoughtful and curious.'
    );
  });

  it('seeds Family notes verbatim to general/family.md', async () => {
    mockListContextEntries.mockResolvedValue([{ title: 'Family notes', content: 'The Thomsen family.' }]);

    await bootstrapMemory();

    expect(mockInsertNextVersion).toHaveBeenCalledWith('general/family.md', 'The Thomsen family.');
  });

  it('does not call uploadDocument or markSynced when insertNextVersion reports created: false', async () => {
    mockListContextEntries.mockResolvedValue([{ title: 'Family notes', content: 'The Thomsen family.' }]);
    mockInsertNextVersion.mockResolvedValue({
      row: archiveRow({ filePath: 'general/family.md', content: 'The Thomsen family.', version: 3 }),
      created: false
    });

    await bootstrapMemory();

    expect(mockUploadDocument).not.toHaveBeenCalled();
    expect(mockMarkSynced).not.toHaveBeenCalled();
  });
});
