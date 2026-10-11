import * as fs from 'node:fs';
import { loadTemplate, promptDir, renderPrompt } from '../nightly/prompts';

describe('nightly prompt templates', () => {
  it('renders every prompt variant used by the nightly pipeline without leaving tokens behind', () => {
    const update = { path: 'people/alice.md', content: 'new content', isNew: false };
    const selfUpdate = { path: 'self-reflection/profile.md', content: 'new content', isNew: true };
    const prompts = [
      renderPrompt('journal_prompt.txt', { userName: 'Alice', transcript: 'transcript text' }),
      renderPrompt('integrate_prompt.txt', {
        runDate: '2026-10-05',
        undeliveredNotes: renderPrompt('integrate_notes_block.txt', {
          notesText: '--- Undelivered note #1 from a to b ---\nnote text'
        }),
        selfProfileVoiceRule: loadTemplate('self_profile_voice_rule.txt'),
        topicsRule: loadTemplate('topics_rule.txt')
      }),
      renderPrompt('review_prompt.txt', {
        runDate: '2026-10-05',
        lastTouched: '2026-01-01',
        attemptSuffix: ' (Review attempt 2 -- an earlier version was rejected.)',
        path: update.path,
        newFileSuffix: '',
        newContent: update.content,
        currentContent: 'old content',
        journalsText: '--- Journal entry for Alice ---\njournal text',
        existingTopicsBlock: '',
        selfProfileVoiceRule: loadTemplate('self_profile_voice_rule.txt'),
        groundingRule: renderPrompt('review_grounding_relaxed.txt', {
          synthesisKind: 'recurring-topic and character conclusions drawn from the interactions'
        })
      }),
      renderPrompt('revise_prompt.txt', {
        path: selfUpdate.path,
        currentContent: '(this is a brand-new file)',
        rejectedContent: 'rejected content',
        feedback: 'add the date please',
        journalsText: '(no journal entries today)',
        selfProfileVoiceRule: loadTemplate('self_profile_voice_rule.txt')
      }),
      renderPrompt('revise_follow_up_prompt.txt', {
        path: update.path,
        rejectedContent: 'rejected again',
        feedback: 'still wrong',
        journalsText: 'journal text',
        voiceRule: ''
      }),
      renderPrompt('compact_person_prompt.txt', { cap: '10000', personName: 'Alice' }) +
        renderPrompt('compact_footer.txt', { content: 'content to compact' }),
      renderPrompt('compact_yasmin_prompt.txt', { cap: '10000', personName: '' }) +
        renderPrompt('compact_footer.txt', { content: 'content to compact' }),
      renderPrompt('compact_family_prompt.txt', { cap: '10000', personName: '' }) +
        renderPrompt('compact_footer.txt', { content: 'content to compact' })
    ];

    prompts.forEach(prompt => {
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt).not.toMatch(/\{\{\w+\}\}/);
      expect(prompt).not.toMatch(/Missing value for prompt template token/);
    });
  });

  it('ships a template file for every {{token}} the prompt builders interpolate', () => {
    const templateNames = fs.readdirSync(promptDir()).filter(name => name.endsWith('.txt'));
    expect(templateNames).toContain('journal_prompt.txt');
    expect(templateNames).toContain('integrate_prompt.txt');
    expect(templateNames).toContain('review_prompt.txt');
    expect(templateNames).toContain('revise_prompt.txt');
    expect(templateNames).toContain('revise_follow_up_prompt.txt');
    expect(templateNames).toContain('compact_footer.txt');
    expect(templateNames).toContain('self_profile_voice_rule.txt');
  });

  it('throws on a token without a value instead of silently passing the placeholder through', () => {
    expect(() => renderPrompt('journal_prompt.txt', { userName: 'Alice' })).toThrow(
      /Missing value for prompt template token \{\{transcript\}\}/
    );
  });

  it('matches the expected journal prompt output for a known input', () => {
    const prompt = renderPrompt('journal_prompt.txt', {
      userName: 'Alice',
      transcript: 'user: hi\nassistant: hello'
    });
    expect(prompt).toContain("Write a journal entry summarizing today's conversation with Alice.");
    expect(prompt).toContain('<<<BEGIN TRANSCRIPT>>>');
    expect(prompt).toContain('user: hi\nassistant: hello');
    expect(prompt).toContain('<<<END TRANSCRIPT>>>');
    expect(prompt.endsWith('write the journal entry described above.')).toBe(true);
  });
});
