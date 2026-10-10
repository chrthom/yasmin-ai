import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Template files for the nightly phase prompts (journal, integrate, review/revision, compact),
 * mirroring the convention of the agent system prompts under mistral_config/**. Only the dynamic
 * interpolations (user name, transcript, journals, ...) are filled in by code; all static wording
 * lives in the template files so it can be reviewed and tuned without a code change.
 *
 * Resolution: today every entry point runs from source via ts-node (src/nightly/...), where the
 * templates sit at ../../mistral_config/nightly/prompts. tsc does not copy .txt files into dist/,
 * so a compiled run has no bundled templates; as a fallback it still finds the repo's source
 * templates relative to the compiled file (dist/nightly -> ../../mistral_config/...), which works
 * whenever dist/ lives inside the repository checkout.
 */
const PROMPT_DIR_PRIMARY = path.resolve(__dirname, '../../mistral_config/nightly/prompts');
const PROMPT_DIR_FALLBACK = path.resolve(process.cwd(), 'mistral_config/nightly/prompts');

function promptDir(): string {
  if (fs.existsSync(PROMPT_DIR_PRIMARY)) {
    return PROMPT_DIR_PRIMARY;
  }
  return PROMPT_DIR_FALLBACK;
}

export function loadTemplate(name: string): string {
  return fs.readFileSync(path.join(promptDir(), name), 'utf8');
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
