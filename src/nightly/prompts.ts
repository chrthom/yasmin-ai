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
 * templates relative to the working directory (mistral_config/nightly/prompts), which works
 * whenever dist/ lies inside the repository checkout.
 */
const PROMPT_DIR_PRIMARY = path.resolve(__dirname, '../../mistral_config/nightly/prompts');
const PROMPT_DIR_FALLBACK = path.resolve(process.cwd(), 'mistral_config/nightly/prompts');

/** One fs read per template; prompt builders call loadTemplate repeatedly within a nightly run. */
const templateCache = new Map<string, string>();

/**
 * Returns the directory the nightly prompt templates are read from: the source checkout's
 * mistral_config dir when it exists (ts-node runs), else the working directory fallback.
 *
 * @returns The resolved prompt template directory.
 */
export function promptDir(): string {
  if (fs.existsSync(PROMPT_DIR_PRIMARY)) {
    return PROMPT_DIR_PRIMARY;
  }
  return PROMPT_DIR_FALLBACK;
}

/**
 * Loads a prompt template by file name, caching it in memory for the rest of the run.
 *
 * @param name The template file name (e.g. 'journal_prompt.txt').
 * @returns The template's raw text.
 * @throws Error when the template file cannot be read.
 */
export function loadTemplate(name: string): string {
  const cached = templateCache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  let template: string;
  try {
    template = fs.readFileSync(path.join(promptDir(), name), 'utf8');
  } catch (error) {
    throw new Error('Could not read prompt template ' + name + ' from ' + promptDir() + ': ' + error);
  }
  templateCache.set(name, template);
  return template;
}

/**
 * Renders a template, replacing every {{token}} occurrence with the given value.
 *
 * @param template The raw template text.
 * @param values The token values to interpolate.
 * @returns The rendered template.
 * @throws Error when a {{token}} in the template has no value.
 */
function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, token: string) => {
    if (!(token in values)) {
      throw new Error('Missing value for prompt template token ' + match);
    }
    return values[token];
  });
}

/**
 * Loads and renders a prompt template in one step.
 *
 * @param name The template file name (e.g. 'journal_prompt.txt').
 * @param values The token values to interpolate.
 * @returns The rendered prompt.
 * @throws Error when the template is missing or a {{token}} has no value.
 */
export function renderPrompt(name: string, values: Record<string, string>): string {
  return renderTemplate(loadTemplate(name), values);
}
