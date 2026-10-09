import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG_FILENAME,
  defaultConfig,
  ensureGitignored,
  Git,
  handoffDirectory,
  loadConfig,
  parseTargets,
  removeFromGitignore,
  writeConfig,
  type HandoffConfig,
} from 'ryujin-handoff-core';
import { boolOption, stringOption, type OptionSpec, type ParsedArgs } from '../args.ts';
import { displayPath, heading, keyValue, out, style } from '../ui.ts';
import { installClaudeCode } from './install.ts';
import { HandoffStore } from 'ryujin-handoff-core';

export const initOptions: Record<string, OptionSpec> = {
  project: { type: 'string', describe: 'Logical name for this codebase (default: directory name)', placeholder: '<name>' },
  targets: { type: 'string', describe: 'Comma-separated consumers this project hands off to', placeholder: '<a,b>' },
  'default-target': { type: 'string', describe: 'Target assumed when none is given', placeholder: '<name>' },
  identity: { type: 'string', describe: 'Which consumer this repository is, for handoffs it receives', placeholder: '<name>' },
  language: { type: 'string', describe: 'Language for handoff prose (default: English)', placeholder: '<name>' },
  gitignore: { type: 'boolean', describe: 'Add the handoff directory to .gitignore (keeps handoffs local)' },
  'no-gitignore': { type: 'boolean', describe: 'Commit handoffs to git instead (default)' },
  'claude-code': { type: 'boolean', describe: 'Also install the /handoff skills into .claude/skills' },
  force: { type: 'boolean', describe: `Overwrite an existing ${CONFIG_FILENAME}` },
};

/**
 * Create `handoff.config.json` and the storage directory.
 *
 * `--gitignore` is a genuine fork rather than a default, because whether handoffs belong in
 * version control is a team decision: some want them reviewed alongside the change they
 * describe, others consider them ephemeral chatter that would pollute history.
 */
export async function initCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const git = new Git(cwd);
  const root = git.root() ?? cwd;
  const configPath = join(root, CONFIG_FILENAME);

  if (existsSync(configPath) && !boolOption(args, 'force')) {
    out(`${style.yellow('Already initialized')} at ${displayPath(configPath, cwd)}`);
    out(`Run ${style.cyan('handoff config')} to see current settings, or re-run with --force to overwrite.`);
    return 0;
  }

  const config: HandoffConfig = defaultConfig(
    stringOption(args, 'project') ?? basenameOf(root),
  );
  const targets = parseTargets(stringOption(args, 'targets'));
  if (targets.length > 0) config.targets = targets;
  const defaultTarget = stringOption(args, 'default-target');
  if (defaultTarget) config.defaultTarget = parseTargets(defaultTarget)[0] ?? null;
  // Who this repository is, which is not who it sends to: only this one narrows an
  // incoming handoff.
  const identity = stringOption(args, 'identity');
  if (identity) config.identity = parseTargets(identity)[0] ?? null;
  const language = stringOption(args, 'language');
  if (language) config.language = language;
  config.gitignore = boolOption(args, 'gitignore') && !boolOption(args, 'no-gitignore');

  writeConfig(root, config);

  const loaded = loadConfig(root);
  const store = new HandoffStore(handoffDirectory(loaded));
  store.ensure();

  heading('Initialized Agents Handoff');
  keyValue('config', displayPath(configPath, cwd));
  keyValue('handoffs', displayPath(store.directory, cwd));
  keyValue('project', config.project);
  if (config.targets.length > 0) keyValue('targets', config.targets.join(', '));
  if (config.identity) keyValue('identity', config.identity);
  keyValue('language', config.language ?? 'English (default)');

  if (config.gitignore) {
    const result = ensureGitignored(root, config.directory);
    keyValue('gitignore', result.changed ? `added ${config.directory}/` : 'already present');
  } else {
    removeFromGitignore(root, config.directory);
    keyValue('gitignore', 'not ignored (handoffs will be committed)');
  }

  if (boolOption(args, 'claude-code')) {
    out();
    const installed = installClaudeCode(root, { force: boolOption(args, 'force') });
    for (const line of installed.messages) out(`  ${line}`);
  }

  out();
  out('Next:');
  out(`  ${style.cyan('handoff context --target mobile')}   inspect what would go into a handoff`);
  out(`  ${style.cyan('handoff create --target mobile')}    write a draft to fill in`);
  out(`  ${style.cyan('/handoff mobile')}                   from Claude Code, if the skills are installed`);
  return 0;
}

function basenameOf(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? 'project';
}
