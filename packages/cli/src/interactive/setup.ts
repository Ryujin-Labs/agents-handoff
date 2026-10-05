import { basename } from 'node:path';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILENAME, Git, SUGGESTED_TARGETS } from 'agents-handoff-core';
import type { ParsedArgs } from '../args.ts';
import { confirm, multiselect, select, text, type Choice } from '../prompt/index.ts';
import { out, style } from '../ui.ts';
import { initCommand } from '../commands/init.ts';

const OTHER = '\u0000other';

/** Walk a developer through `handoff init`. */
export async function interactiveInit(cwd: string): Promise<number> {
  const root = new Git(cwd).root() ?? cwd;
  const already = existsSync(join(root, CONFIG_FILENAME));

  out();
  out(`${style.dim('setting up')} ${style.bold(root)}`);
  if (already) {
    out(style.yellow(`${CONFIG_FILENAME} already exists here.`));
    if (!(await confirm({ message: 'Overwrite it?', default: false }))) {
      out(style.dim('Left as it was.'));
      return 0;
    }
  }
  out();

  const project = await text({
    message: 'What is this codebase called?',
    default: basename(root),
    validate: (value) => (value.trim() ? null : 'give it a name'),
  });

  const targets = await multiselect<string>({
    message: 'Who do you hand work off to?',
    choices: SUGGESTED_TARGETS.map((target) => ({ value: target, label: target })),
    required: false,
  });

  const extra = await text({
    message: 'Anyone else?',
    default: '',
    placeholder: 'press enter to skip',
  });
  for (const part of extra.split(/[\s,]+/).filter(Boolean)) targets.push(part);

  const language = await pickLanguage();

  const commit = await select<boolean>({
    message: 'Should handoffs be committed to git?',
    choices: [
      {
        value: true,
        label: 'yes, commit them',
        hint: 'reviewed alongside the change they describe',
      },
      { value: false, label: 'no, keep them local', hint: 'adds .handoff/ to .gitignore' },
    ],
  });

  const skills = await confirm({
    message: 'Install the /handoff skills for Claude Code?',
    default: true,
  });

  const values: ParsedArgs['values'] = { project, force: true };
  if (targets.length > 0) values['targets'] = [...new Set(targets)].join(',');
  if (language) values['language'] = language;
  if (!commit) values['gitignore'] = true;
  if (skills) values['claude-code'] = true;

  return initCommand({ values, positionals: [] }, cwd);
}

/**
 * English is the default because a handoff crosses a team boundary and the receiving
 * team's language is not knowable from this repository. Anything else is a deliberate
 * choice, so it is asked for rather than inferred.
 */
async function pickLanguage(): Promise<string | null> {
  const choices: Array<Choice<string>> = [
    { value: '', label: 'English', hint: 'default — travels between teams' },
    { value: OTHER, label: 'something else…', hint: 'headings stay English either way' },
  ];
  const answer = await select<string>({
    message: 'What language should handoffs be written in?',
    choices,
  });
  if (answer !== OTHER) return null;

  const named = await text({
    message: 'Which language?',
    placeholder: 'Turkish, Japanese, Deutsch…',
    validate: (value) => (value.trim() ? null : 'name it, or ctrl+c to keep English'),
  });
  return named;
}
