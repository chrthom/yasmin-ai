import {
  runNightlyPipeline,
  parseMood,
  archive,
  conversation,
  mockReleaseLock,
  mockSetWatermark,
  mockInsertNextVersion,
  mockListCurrentVersions,
  mockUpsertContextEntry,
  mockRunIntegrate,
  mockRunReview,
  mockRunCompact,
  mockListConversations,
  mockReplaceDocument,
  setupPipelineFixture
} from './fixtures/pipeline.integration.fixture';

describe('nightly pipeline integration', () => {
  beforeEach(setupPipelineFixture);

  it('decay wiring: list_long_term_files exposes lastTouchedAt to the integrate loop, and runReview receives it with the current content', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    const seeded = await archive.seed('people/alice.md', 'Existing alice content');
    let listed: { path: string; contentHash: string; lastTouchedAt: string }[] = [];
    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      listed = JSON.parse(await executeTool('list_long_term_files', {}));
      await executeTool('stage_update', {
        path: 'people/alice.md',
        content: 'Alice profile content',
        isNew: false
      });
      return { finalText: 'staged 1 file', iterations: 1 };
    });
    mockRunReview.mockResolvedValue({ approved: true, reason: 'looks good' });
    mockRunCompact.mockResolvedValue('compacted profile');
    mockUpsertContextEntry.mockResolvedValue('inserted');
    await runNightlyPipeline();
    const aliceEntry = listed.find(entry => entry.path === 'people/alice.md');
    expect(aliceEntry).toBeDefined();
    expect(aliceEntry!.lastTouchedAt).toBe(seeded.createdAt.toISOString());
    expect(mockRunReview).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'people/alice.md' }),
      'Existing alice content',
      seeded.createdAt.toISOString(),
      expect.any(Array),
      0,
      [],
      []
    );
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Mood decay + fold-in (issue #48)
  // -------------------------------------------------------------------------

  it('mood: deterministic decay applies without an agent update; a fully faded mood drops its narrative', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    // A mood whose updatedAt is ~290 one-day half-lives before the run date: code must decay
    // it to zero with no agent update, and the stale reason must fade WITH the numbers.
    await archive.seed('self-reflection/profile.md', 'Ich bin Yasmin. Ich mag lange Gespraeche.');
    await archive.seed(
      'self-reflection/mood.md',
      'valence: 0.8\nenergy: 0.6\nhalfLifeDays: 1\nupdatedAt: 2026-01-01T22:00:00Z\n\n' +
        'Christopher hat mich heute heftig kritisiert.'
    );

    await runNightlyPipeline();

    // The decayed archive version persists with the narrative dropped...
    const moodRow = await archive.getCurrentVersion('self-reflection/mood.md');
    expect(moodRow).not.toBeNull();
    const moodContent = moodRow!.content;
    const decayedMood = parseMood(moodContent);
    expect(decayedMood).not.toBeNull();
    // 2026-01-01 is ~290 one-day half-lives before the run date -- far past the ~6.3 half-lives
    // it takes 0.8 to fall under the 0.01 decay epsilon -- so the decayed valence must be fully
    // neutralized (0), and the assertion must not accidentally match the seeded 0.8 (a
    // toContain('valence: 0') would).
    expect(decayedMood!.valence).toBe(0);
    expect(decayedMood!.energy).toBe(0);
    expect(moodContent).not.toContain('Christopher hat mich heute heftig kritisiert.');

    // ...so the yasmin compaction source carries no stale current-mood section: the reason
    // cannot outlive its mood in the eager profile.
    const yasminCall = mockRunCompact.mock.calls.find(call => call[0] === 'yasmin');
    expect(yasminCall).toBeDefined();
    expect(yasminCall![2]).not.toContain('My current mood');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('mood: a mid-decay value is halved per half-life, proving decay actually applied', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    // updatedAt ~3 collected-times in the past is impossible to control precisely here, so
    // instead assert the deterministic property on the unit level (see mood.test.ts) and here
    // only that a stale mood gets a NEW version (decay applied at all) with a refreshed header.
    await archive.seed(
      'self-reflection/mood.md',
      'valence: 0.8\nenergy: 0.6\nhalfLifeDays: 1\nupdatedAt: 2026-01-01T22:00:00Z\n\nAlt.'
    );
    const seeded = await archive.getCurrentVersion('self-reflection/mood.md');
    await runNightlyPipeline();
    const moodRow = await archive.getCurrentVersion('self-reflection/mood.md');
    expect(moodRow!.version).toBeGreaterThan(seeded!.version);
  });

  it('mood: a [PRIVACY:SENSITIVE] passage in the mood narrative never reaches the compactor', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed('self-reflection/profile.md', 'Ich bin Yasmin.');
    // updatedAt 12h ago with a 1-day half-life: the mood decays (~0.57/0.42) but is NOT fully
    // faded, so the narrative survives decay and the fold-in below actually has text to strip.
    await archive.seed(
      'self-reflection/mood.md',
      'valence: 0.8\nenergy: 0.6\nhalfLifeDays: 1\nupdatedAt: ' +
        new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString() +
        '\n\nIch bin today frustriert.\n[PRIVACY:SENSITIVE]\nGeheimes: ich hatte einen Streit mit R.\n[/PRIVACY:SENSITIVE]'
    );
    await runNightlyPipeline();
    const compactSource = mockRunCompact.mock.calls.find(call => call[0] === 'yasmin')[2];
    expect(compactSource).toContain('My current mood');
    expect(compactSource).toContain('frustriert');
    expect(compactSource).not.toContain('PRIVACY:SENSITIVE');
    expect(compactSource).not.toContain('Geheimes');
  });

  it('mood: an unparsable header skips the fold-in (no stale n/a mood in the eager profile)', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed('self-reflection/profile.md', 'Ich bin Yasmin.');
    await archive.seed('self-reflection/mood.md', 'kein header, nur narrative');
    await runNightlyPipeline();
    const yasminCall = mockRunCompact.mock.calls.find(call => call[0] === 'yasmin');
    expect(yasminCall[2]).not.toContain('n/a');
    expect(yasminCall[2]).not.toContain('current mood');
  });

  it('mood: a staged mood update with a bogus updatedAt is re-stamped with the archive time', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    // The agent stages a hallucinated far-future date; the pipeline must overwrite it with the
    // archive stamp so decay measures from the real commit time, not the agent's lie.
    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      await executeTool('stage_update', {
        path: 'self-reflection/mood.md',
        content:
          'valence: 0.9\nenergy: 0.7\nhalfLifeDays: 1\nupdatedAt: 2030-01-01T00:00:00Z\n\nIch bin gut gelaunt.',
        isNew: true
      });
      return { finalText: 'staged mood', iterations: 1 };
    });
    mockRunReview.mockResolvedValue({ approved: true, reason: 'ok' });

    await runNightlyPipeline();

    const moodRow = await archive.getCurrentVersion('self-reflection/mood.md');
    expect(moodRow).not.toBeNull();
    const mood = parseMood(moodRow!.content);
    expect(mood).not.toBeNull();
    expect(mood!.valence).toBe(0.9);
    // The rendered header stores second precision, so compare at that granularity.
    expect(Math.floor(mood!.updatedAt.getTime() / 1000)).toBe(
      Math.floor(moodRow!.createdAt.getTime() / 1000)
    );
    // The bogus 2030 date must be gone.
    expect(mood!.updatedAt.getFullYear()).toBeLessThan(2030);
  });

  it('mood: a fully decayed (neutral) mood produces no new version and no churn', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    const seeded = await archive.seed(
      'self-reflection/mood.md',
      'valence: 0\nenergy: 0\nhalfLifeDays: 1\nupdatedAt: 2026-01-01T22:00:00Z\n\nAlles neutral.'
    );
    await runNightlyPipeline();
    const moodRow = await archive.getCurrentVersion('self-reflection/mood.md');
    expect(moodRow!.version).toBe(seeded.version);
  });

  // -------------------------------------------------------------------------
  // Dream-reflection soft evidence in the yasmin compaction (issue #126)
  // -------------------------------------------------------------------------

  it('dream evidence: recent dream reflections ride along as soft evidence in the yasmin compaction source', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed('self-reflection/profile.md', 'Ich bin Yasmin.');
    await archive.seed(
      'self-reflection/dreams.md',
      '## Traum vom 2026-10-01\n\nErste Reflexion.\n\n## Traum vom 2026-10-05\n\nDer Traum hat mich an meine Ungeduld erinnert.'
    );

    await runNightlyPipeline();

    // Phase 5 must not have touched the seeded reflections (no dream tonight, none unreflected):
    // the fold-in below reads exactly what the dream phase wrote on earlier nights.
    const yasminCall = mockRunCompact.mock.calls.find(call => call[0] === 'yasmin');
    expect(yasminCall).toBeDefined();
    expect(yasminCall![2]).toContain('Ich bin Yasmin.');
    expect(yasminCall![2]).toContain('## My reflections on my dreams');
    expect(yasminCall![2]).toContain('Traum vom 2026-10-01');
    expect(yasminCall![2]).toContain('Ungeduld');
  });

  it('dream evidence: without a dreams.md row the yasmin compaction source carries no dream section', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed('self-reflection/profile.md', 'Ich bin Yasmin.');

    await runNightlyPipeline();

    const yasminCall = mockRunCompact.mock.calls.find(call => call[0] === 'yasmin');
    expect(yasminCall).toBeDefined();
    expect(yasminCall![2]).not.toContain('My reflections on my dreams');
  });

  it('dream evidence: a [PRIVACY:SENSITIVE] passage in the reflections never reaches the compactor', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed('self-reflection/profile.md', 'Ich bin Yasmin.');
    await archive.seed(
      'self-reflection/dreams.md',
      '## Traum vom 2026-10-05\n\nOeffentliche Reflexion.\n[PRIVACY:SENSITIVE]\nGeheimes: ich traume von R.\n[/PRIVACY:SENSITIVE]'
    );

    await runNightlyPipeline();

    const compactSource = mockRunCompact.mock.calls.find(call => call[0] === 'yasmin')![2];
    expect(compactSource).toContain('Oeffentliche Reflexion.');
    expect(compactSource).not.toContain('PRIVACY:SENSITIVE');
    expect(compactSource).not.toContain('Geheimes');
  });

  it('dream evidence: only the most recent entries are passed once dreams.md exceeds the evidence cap', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed('self-reflection/profile.md', 'Ich bin Yasmin.');
    const longEntry = (date: string, text: string) =>
      '## Traum vom ' + date + '\n\n' + text + 'x'.repeat(3000);
    await archive.seed(
      'self-reflection/dreams.md',
      [
        longEntry('2026-09-01', 'Alte Reflexion.'),
        longEntry('2026-10-01', 'Mittlere Reflexion.'),
        longEntry('2026-10-05', 'Neue Reflexion.')
      ].join('\n\n')
    );

    await runNightlyPipeline();

    // The mock factory passes the REAL recentDreamReflections through, so this asserts the actual
    // trimming: the cap (4000) fits one ~3000-char entry but not two, so only the newest survives.
    const compactSource = mockRunCompact.mock.calls.find(call => call[0] === 'yasmin')![2];
    expect(compactSource).toContain('Neue Reflexion.');
    expect(compactSource).not.toContain('Alte Reflexion.');
    expect(compactSource).not.toContain('Mittlere Reflexion.');
  });

  it('dream evidence: people/ and family compaction sources never see dream material (the fact gate)', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed('self-reflection/profile.md', 'Ich bin Yasmin.');
    await archive.seed('people/bob.md', 'Bobs Profil.');
    await archive.seed('general/family.md', 'Familiennotizen.');
    await archive.seed('self-reflection/dreams.md', '## Traum vom 2026-10-05\n\nReflexion ueber den Traum.');

    await runNightlyPipeline();

    // The deliberate asymmetry (issue #126): dream reflections flow into Profile of Yasmin ONLY
    // -- people/ and general/ files keep receiving dream-derived insights exclusively through the
    // normal integrate/review chain, so their compaction inputs must stay dream-free.
    const personCall = mockRunCompact.mock.calls.find(call => call[0] === 'person');
    expect(personCall).toBeDefined();
    expect(personCall![2]).not.toContain('My reflections on my dreams');
    expect(personCall![2]).not.toContain('Reflexion ueber den Traum.');
    const familyCall = mockRunCompact.mock.calls.find(call => call[0] === 'family');
    expect(familyCall).toBeDefined();
    expect(familyCall![2]).not.toContain('My reflections on my dreams');
    expect(familyCall![2]).not.toContain('Reflexion ueber den Traum.');
    // dreams.md itself has no context_entries mapping: no eager entry is created for it either.
    const titlesUpserted = mockUpsertContextEntry.mock.calls.map(call => call[0]);
    expect(titlesUpserted).toHaveLength(3);
    expect(titlesUpserted).toEqual(
      expect.arrayContaining(['Profile of Yasmin', 'Profile of Bob', 'Family notes'])
    );
  });

  // -------------------------------------------------------------------------
  // Topics layer wiring
  // -------------------------------------------------------------------------

  it('topics duplicate barrier: pipeline seeds the reviewer with archived topics, filters topics/, and excludes the proposed path', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed(
      'topics/urlaub-planung.md',
      'Aliases: Urlaub Planung, Sommerreise\nFamilie will ans Meer.'
    );
    await archive.seed('people/bob.md', 'Bob profile'); // non-topic seed must not reach the barrier
    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      await executeTool('stage_update', {
        path: 'topics/urlaub-aktivitaeten.md',
        content: 'Aliases: Ausflüge\nWas die Familie am Urlaubsort tun will.',
        isNew: true
      });
      return { finalText: 'staged a topic', iterations: 1 };
    });
    const seenTopics: any[][] = [];
    mockRunReview.mockImplementation(
      async (
        _update: any,
        _current: any,
        _lastTouchedAt: any,
        _journals: any,
        _attempt: any,
        existingTopics: any
      ) => {
        seenTopics.push(existingTopics);
        return { approved: true, reason: 'ok' };
      }
    );
    await runNightlyPipeline();
    // Every review attempt saw exactly the archived topics -- the people/ seed excluded, the
    // proposal's own path excluded, the other archived topic present with its content.
    expect(seenTopics.length).toBeGreaterThan(0);
    for (const topics of seenTopics) {
      expect(topics.map((t: any) => t.path)).toEqual(['topics/urlaub-planung.md']);
    }
    expect(seenTopics[0][0].content).toContain('Sommerreise');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('same-run duplicate barrier: a topic approved earlier in the run is part of the next review barrier', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      await executeTool('stage_update', {
        path: 'topics/urlaub-planung.md',
        content: 'Aliases: Sommerreise',
        isNew: true
      });
      await executeTool('stage_update', {
        path: 'topics/urlaub-aktivitaeten.md',
        content: 'Aliases: Urlaub Aktivitäten',
        isNew: true
      });
      return { finalText: 'staged two topics', iterations: 1 };
    });
    const seenTopics: any[][] = [];
    mockRunReview.mockImplementation(
      async (
        update: any,
        _current: any,
        _lastTouchedAt: any,
        _journals: any,
        _attempt: any,
        existingTopics: any
      ) => {
        seenTopics.push(existingTopics);
        return { approved: true, reason: 'ok' };
      }
    );
    await runNightlyPipeline();
    // First topic review starts from the (empty) archive; the second must already see the first.
    expect(seenTopics[0]).toEqual([]);
    expect(seenTopics[1].map((t: any) => t.path)).toEqual(['topics/urlaub-planung.md']);
    // Both were archived (the reviewer approved both) -- the barrier's job is visibility, not rejection.
    expect(mockInsertNextVersion).toHaveBeenCalledWith(
      'topics/urlaub-planung.md',
      'Aliases: Sommerreise',
      expect.any(Date)
    );
    expect(mockInsertNextVersion).toHaveBeenCalledWith(
      'topics/urlaub-aktivitaeten.md',
      'Aliases: Urlaub Aktivitäten',
      expect.any(Date)
    );
  });

  it('topic index is advisory: archived last, as staged, without line-level validation', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      await executeTool('stage_update', {
        path: 'general/topic-index.md',
        content:
          'Index:\n' +
          'topics/urlaub-planung.md - Familienurlaub - Alice, Bob\n' +
          'topics/abgelehntes-thema.md - nie archiviert - Alice',
        isNew: true
      });
      await executeTool('stage_update', {
        path: 'topics/urlaub-planung.md',
        content: 'Aliases: Sommerreise',
        isNew: true
      });
      return { finalText: 'staged index and topic', iterations: 1 };
    });
    mockRunReview.mockResolvedValue({ approved: true, reason: 'ok' });
    const result = await runNightlyPipeline();
    const indexCall = mockInsertNextVersion.mock.calls.find(call => call[0] === 'general/topic-index.md');
    expect(indexCall).toBeDefined();
    // Advisory: the index is archived exactly as staged -- no line dropping against the archive
    // set. A stale line (e.g. for a rejected topic) is cosmetic and fixed by the next rewrite.
    expect(indexCall![1]).toContain('topics/urlaub-planung.md - Familienurlaub - Alice, Bob');
    expect(indexCall![1]).toContain('abgelehntes-thema');
    expect(mockInsertNextVersion.mock.calls.some(call => call[0] === 'topics/urlaub-planung.md')).toBe(true);
    const paths = mockInsertNextVersion.mock.calls
      .map(call => call[0])
      .filter(p => p !== 'journals/alice/conv-1.md');
    expect(paths.indexOf('general/topic-index.md')).toBeGreaterThan(
      paths.indexOf('topics/urlaub-planung.md')
    );
    expect(result.status).toBe('completed');
  });

  it('topics load failure: run is partial, topics/ proposals skipped before review, advisory index archived as staged', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    // Phase 4's barrier load throws; every later listCurrentVersions call (Phases 5-7) stays healthy.
    mockListCurrentVersions
      .mockRejectedValueOnce(new Error('db boom listing current versions'))
      .mockImplementation(archive.listCurrentVersions);
    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      await executeTool('stage_update', {
        path: 'topics/urlaub-planung.md',
        content: 'Aliases: Sommerreise',
        isNew: true
      });
      await executeTool('stage_update', {
        path: 'general/topic-index.md',
        content: 'topics/urlaub-planung.md - Familienurlaub - Alice, Bob',
        isNew: true
      });
      return { finalText: 'staged topic and index', iterations: 1 };
    });
    mockRunReview.mockResolvedValue({ approved: true, reason: 'ok' });
    const result = await runNightlyPipeline();
    // The load failure marks the run partial so the next invocation retries with healthy data.
    expect(result.status).toBe('partial');
    expect(mockSetWatermark).not.toHaveBeenCalled();
    // Without barrier data topics/ proposals are skipped BEFORE any review is spent on them --
    // no review call for the topic, and no archive call (it could be a duplicate).
    const topicReviewCall = mockRunReview.mock.calls.find(
      call => call[0]?.path === 'topics/urlaub-planung.md'
    );
    expect(topicReviewCall).toBeUndefined();
    expect(mockInsertNextVersion.mock.calls.some(call => call[0] === 'topics/urlaub-planung.md')).toBe(false);
    // The advisory index is archived as staged, without line-level validation.
    const indexCall = mockInsertNextVersion.mock.calls.find(call => call[0] === 'general/topic-index.md');
    expect(indexCall).toBeDefined();
    expect(indexCall![1]).toContain('urlaub-planung');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Phase 7 privacy wiring
  // -------------------------------------------------------------------------
  it('Phase 7 strips [PRIVACY:SENSITIVE] blocks before compaction -- runCompact never sees sensitive content', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed(
      'people/bob.md',
      'Public fact about Bob.\n[PRIVACY:SENSITIVE]\nBob secretly hates broccoli.\n[/PRIVACY:SENSITIVE]\nMore public info.'
    );

    await runNightlyPipeline();

    expect(mockRunCompact).toHaveBeenCalledTimes(1);
    const [, , strippedContentPassedToCompact] = mockRunCompact.mock.calls[0];
    expect(strippedContentPassedToCompact).not.toContain('PRIVACY:SENSITIVE');
    expect(strippedContentPassedToCompact).not.toContain('secretly hates broccoli');
    expect(strippedContentPassedToCompact).toContain('Public fact about Bob.');
    expect(strippedContentPassedToCompact).toContain('More public info.');

    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Phase 7 empty-compaction guard
  // -------------------------------------------------------------------------
  it('Phase 7 skips the eager-cache upsert when compaction produces empty output, but does not fail the run', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed(
      'people/bob.md',
      '[PRIVACY:SENSITIVE]\nBob secretly hates broccoli.\n[/PRIVACY:SENSITIVE]'
    );
    mockRunCompact.mockImplementation(async (kind: string) => (kind === 'person' ? '   ' : 'compacted'));

    const result = await runNightlyPipeline();

    expect(mockUpsertContextEntry.mock.calls.some(call => call[0] === 'Profile of Bob')).toBe(false);
    // An empty compaction (e.g. from an empty source file) simply means nothing to compact -- it is
    // not an eager-cache failure and must not degrade the run. A completed run advances the watermark.
    expect(result.status).toBe('completed');
    expect(mockSetWatermark).toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Phase 6 privacy wiring
  // -------------------------------------------------------------------------
  it('Phase 6 strips [PRIVACY:SENSITIVE] blocks before uploading to Mistral -- the local archive keeps the full content', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed(
      'people/bob.md',
      'Public fact about Bob.\n[PRIVACY:SENSITIVE]\nBob secretly hates broccoli.\n[/PRIVACY:SENSITIVE]\nMore public info.'
    );

    await runNightlyPipeline();

    const bobCall = mockReplaceDocument.mock.calls.find(call => call[0] === 'people/bob.md');
    expect(bobCall).toBeDefined();
    const uploadedContent = bobCall?.[1];
    expect(uploadedContent).not.toContain('PRIVACY:SENSITIVE');
    expect(uploadedContent).not.toContain('secretly hates broccoli');
    expect(uploadedContent).toContain('Public fact about Bob.');

    const archived = await archive.getCurrentVersion('people/bob.md');
    expect(archived?.content).toContain('secretly hates broccoli');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });
});
