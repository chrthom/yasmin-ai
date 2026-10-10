jest.mock('../database/models/context.model', () => ({
  getAllEntriesFromDb: jest.fn(),
  getAllTitlesFromDb: jest.fn(),
  getContentByTitleFromDb: jest.fn()
}));

import { getAllTitlesFromDb } from '../database/models/context.model';
import { DbProxy, PROXY_DATA } from '../database/db_proxy';

const mockGetAllTitlesFromDb = getAllTitlesFromDb as jest.Mock;

describe('db_proxy.isKnownPerson', () => {
  afterEach(() => {
    mockGetAllTitlesFromDb.mockReset();
  });

  it('recognizes a person from the static proxy data when the DB is disabled', async () => {
    const proxy = new DbProxy(false);
    expect(await proxy.isKnownPerson('Zara')).toBe(true);
    expect(await proxy.isKnownPerson('zara')).toBe(true);
    expect(await proxy.isKnownPerson('Yasmin')).toBe(true);
    expect(mockGetAllTitlesFromDb).not.toHaveBeenCalled();
  });

  it('rejects an unknown person when the DB is disabled', async () => {
    const proxy = new DbProxy(false);
    expect(await proxy.isKnownPerson('Mira')).toBe(false);
  });

  it('consults context_entries first when the real DB is enabled (DB-only profile)', async () => {
    // A brand-new person profile the nightly integrate agent created -- present in the DB
    // but not in the static PROXY_DATA list.
    mockGetAllTitlesFromDb.mockResolvedValueOnce([
      ...PROXY_DATA.map(record => record.title),
      'Profile of Mira'
    ]);
    const proxy = new DbProxy(true);
    expect(await proxy.isKnownPerson('Mira')).toBe(true);
    expect(mockGetAllTitlesFromDb).toHaveBeenCalledTimes(1);
  });

  it('falls back to the proxy data when the DB lookup fails', async () => {
    mockGetAllTitlesFromDb.mockRejectedValueOnce(new Error('db down'));
    const proxy = new DbProxy(true);
    expect(await proxy.isKnownPerson('Zara')).toBe(true);
  });

  it('rejects an empty or blank name', async () => {
    const proxy = new DbProxy(false);
    expect(await proxy.isKnownPerson('')).toBe(false);
    expect(await proxy.isKnownPerson('   ')).toBe(false);
  });
});
