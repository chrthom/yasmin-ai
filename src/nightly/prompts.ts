import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Template files for the nightly phase prompts (journal, integrate, review/revision, compact),
 * mirroring the convention of the agent system prompts under mistral_config/**. Only the dynamic
 * interpolations (user name, transcript, journals, ...) are filled in by code; all static wording
 * lives in the template files so it can be reviewed and tuned without a code change.
 */
const PROMPT_DIR = path.resolve(__dirname, '../../mistral_config/nightly/prompts');

export function loadTemplate(name: string): string {
  return fs.readFileSync(path.join(PROMPT_DIR, name), 'utf8');
}

/** Renders a template, replacing every {{token}} occurrence with the given value. */
function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, token: string) => {
    if (!(token in values)) {
      throw new Error('Missing value for prompt template token ' + match);
    }
    return values[token];
  });
}

export function renderPrompt(name: string, values: Record<string, string>): string {
  return renderTemplate(loadTemplate(name), values);
}
