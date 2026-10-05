import {
  BUILTIN_COLLECTORS,
  CONFIG_FILENAME,
  configProblems,
  deliveryOptions,
  formatDeliveryOptions,
  ensureGitignored,
  handoffDirectory,
  loadConfig,
  parseTargets,
  removeFromGitignore,
  SUGGESTED_TARGETS,
  writeConfig,
} from 'agents-handoff-core';
import { boolOption, stringOption, type OptionSpec, type ParsedArgs } from '../args.ts';
import { displayPath, heading, jsonOut, keyValue, out, style } from '../ui.ts';

export const configOptions: Record<string, OptionSpec> = {
  json: { type: 'boolean', describe: 'Emit the resolved configuration as JSON' },
  collectors: { type: 'boolean', describe: 'List available context collectors' },
  channels: { type: 'boolean', describe: 'List available delivery channels' },
  'set-project': { type: 'string', describe: 'Set the logical project name', placeholder: '<name>' },
  'set-targets': { type: 'string', describe: 'Set the known consumers', placeholder: '<a,b>' },
  'set-default-target': { type: 'string', describe: 'Set the target assumed when none is given', placeholder: '<name>' },
  'set-identity': { type: 'string', describe: 'Set which consumer this repository is, for handoffs it receives', placeholder: '<name>' },
  'set-language': { type: 'string', describe: 'Language for handoff prose; empty string resets to English', placeholder: '<name>' },
  gitignore: { type: 'boolean', describe: 'Start ignoring the handoff directory' },
  'no-gitignore': { type: 'boolean', describe: 'Stop ignoring the handoff directory' },
};

export async function configCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const loaded = loadConfig(cwd);

  if (boolOption(args, 'collectors')) {
    heading('Context collectors');
    for (const collector of BUILTIN_COLLECTORS) {
      const disabled = loaded.config.context.disabledCollectors.includes(collector.name);
      out(`  ${collector.name.padEnd(16)} ${collector.description} ${disabled ? style.dim('(disabled)') : ''}`);
    }
    return 0;
  }

  if (boolOption(args, 'channels')) {
    // Judged with this project's settings: asking a channel whether it works with no
    // settings at all reported every configured webhook as unavailable.
    heading('Delivery channels');
    out(formatDeliveryOptions(deliveryOptions(loaded.config, [])).replace(/^/gm, '  '));
    printProblems(loaded.config);
    return 0;
  }

  const mutated = applyMutations(args, loaded, cwd);
  if (mutated) return 0;

  if (boolOption(args, 'json')) {
    jsonOut({ ...loaded.config, _root: loaded.root, _path: loaded.path, _exists: loaded.exists });
    return 0;
  }

  heading(loaded.exists ? 'Configuration' : 'Configuration (defaults; no config file found)');
  keyValue('root', displayPath(loaded.root, cwd));
  keyValue('config', loaded.path ? displayPath(loaded.path, cwd) : style.dim('(none)'));
  keyValue('project', loaded.config.project);
  keyValue('directory', displayPath(handoffDirectory(loaded), cwd));
  keyValue('gitignored', loaded.config.gitignore ? 'yes' : 'no');
  keyValue('targets', loaded.config.targets.join(', ') || style.dim(`(none set; e.g. ${SUGGESTED_TARGETS.slice(0, 4).join(', ')})`));
  keyValue('defaultTarget', loaded.config.defaultTarget ?? style.dim('(none)'));
  keyValue('identity', loaded.config.identity ?? style.dim('(none; pass --as when receiving)'));
  keyValue('language', loaded.config.language ?? `English ${style.dim('(default)')}`);
  keyValue('git context', loaded.config.includeGitContext ? 'on' : 'off');
  keyValue('tests', loaded.config.includeTests ? 'on' : 'off');
  keyValue('maxFiles', String(loaded.config.context.maxFiles));
  keyValue('maxCommits', String(loaded.config.context.maxCommits));
  if (loaded.config.context.disabledCollectors.length > 0) {
    keyValue('disabled', loaded.config.context.disabledCollectors.join(', '));
  }
  const routes = Object.entries(loaded.config.routes);
  if (routes.length > 0) {
    keyValue('routes', routes.map(([target, ids]) => `${target} → ${ids.join(', ')}`).join('; '));
  }
  printProblems(loaded.config);

  if (!loaded.exists) {
    out();
    out(`Run ${style.cyan('handoff init')} to write a ${CONFIG_FILENAME}.`);
  }
  return 0;
}

/** Say what is wrong with delivery settings, including webhooks written into the file. */
function printProblems(config: ReturnType<typeof loadConfig>['config']): void {
  const problems = configProblems(config);
  if (problems.length === 0) return;
  out();
  for (const problem of problems) out(`${style.yellow('warn')} ${problem}`);
}

/** Apply any `--set-*` flags. Returns true when the config was written. */
function applyMutations(args: ParsedArgs, loaded: ReturnType<typeof loadConfig>, cwd: string): boolean {
  const config = { ...loaded.config };
  let changed = false;

  const project = stringOption(args, 'set-project');
  if (project) {
    config.project = project;
    changed = true;
  }
  const targets = stringOption(args, 'set-targets');
  if (targets !== undefined) {
    config.targets = parseTargets(targets);
    changed = true;
  }
  const defaultTarget = stringOption(args, 'set-default-target');
  if (defaultTarget !== undefined) {
    config.defaultTarget = parseTargets(defaultTarget)[0] ?? null;
    changed = true;
  }
  const identity = stringOption(args, 'set-identity');
  if (identity !== undefined) {
    config.identity = parseTargets(identity)[0] ?? null;
    changed = true;
  }
  const language = stringOption(args, 'set-language');
  if (language !== undefined) {
    config.language = language.trim() ? language.trim() : null;
    changed = true;
  }
  if (boolOption(args, 'gitignore')) {
    config.gitignore = true;
    ensureGitignored(loaded.root, config.directory);
    changed = true;
  }
  if (boolOption(args, 'no-gitignore')) {
    config.gitignore = false;
    removeFromGitignore(loaded.root, config.directory);
    changed = true;
  }

  if (!changed) return false;
  const path = writeConfig(loaded.root, config);
  out(`${style.green('updated')} ${displayPath(path, cwd)}`);
  return true;
}
