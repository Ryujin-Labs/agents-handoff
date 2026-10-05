import { join, relative } from 'node:path';
import {
  collectChangeContext,
  Git,
  handoffDirectory,
  loadConfig,
  scaffoldHandoff,
  truncate,
} from 'agents-handoff-core';
import type { ParsedArgs } from '../args.ts';
import { confirm, select, text } from '../prompt/index.ts';
import { err, out, style } from '../ui.ts';
import { createCommand } from '../commands/create.ts';
import { sendCommand } from '../commands/send.ts';
import { pickChannel, pickTargets } from './pick.ts';
import { describeScope, pickScope, type ScopeAnswer } from './scope.ts';

/**
 * Walk a developer through creating a handoff, then hand off to the same command the flags
 * path uses. Nothing here re-implements creation — it only gathers the answers.
 */
export async function interactiveCreate(cwd: string): Promise<number> {
  const loaded = loadConfig(cwd);
  const git = new Git(cwd);

  if (!git.isRepo()) {
    err(`${style.red('error')} not a git repository, so there is no change to describe.`);
    return 1;
  }
  if (!git.hasCommits()) {
    err(`${style.red('error')} this repository has no commits yet.`);
    return 1;
  }

  out();
  out(
    `${style.dim('repository')} ${style.bold(loaded.config.project)}` +
      `${git.branch() ? style.dim(` · ${git.branch()}`) : ''}`,
  );
  if (!loaded.exists) {
    out(style.dim(`no handoff.config.json yet — using defaults. "handoff init" writes one.`));
  }
  out();

  const scope = await pickScope(cwd);
  const targets = await pickTargets(loaded.config);
  const title = await askTitle(cwd, loaded, scope, targets);

  out();
  out(`  ${style.dim('covering')}  ${describeScope(cwd, scope)}`);
  out(`  ${style.dim('for')}       ${targets.join(', ') || 'any consumer'}`);
  out(`  ${style.dim('titled')}    ${title}`);
  out(`  ${style.dim('language')}  ${loaded.config.language ?? 'English'}`);
  out();

  out(
    style.dim(
      'This writes a draft with the facts filled in and the judgment left blank. Your agent',
    ),
  );
  out(style.dim('writes the actual handoff — see "What now?" once it exists.'));
  out();

  if (!(await confirm({ message: 'Create the draft?' }))) {
    out(style.dim('Nothing created.'));
    return 0;
  }

  const code = await createCommand(toArgs(scope, targets, title), cwd);
  if (code !== 0) return code;

  return offerNextStep(cwd);
}

/** Suggest the title the scaffolder would pick, so enter is usually the right answer. */
async function askTitle(
  cwd: string,
  loaded: ReturnType<typeof loadConfig>,
  scope: ScopeAnswer,
  targets: string[],
): Promise<string> {
  let suggestion = 'Untitled change';
  try {
    const context = collectChangeContext({ cwd, loaded, targets, ...scope });
    suggestion = scaffoldHandoff({ context, targets }).title;
  } catch {
    // A title suggestion is a convenience; never let it block the flow.
  }
  return text({
    message: 'Title?',
    default: truncate(suggestion, 70),
    validate: (value) => (value.trim() ? null : 'give it a title'),
  });
}

function toArgs(scope: ScopeAnswer, targets: string[], title: string): ParsedArgs {
  const values: ParsedArgs['values'] = { title };
  if (targets.length > 0) values['target'] = targets.join(',');
  if (scope.base) values['base'] = scope.base;
  if (scope.commits) values['commits'] = String(scope.commits);
  if (scope.since) values['since'] = scope.since;
  if (scope.staged) values['staged'] = true;
  if (scope.working) values['working'] = true;
  return { values, positionals: [] };
}

type NextStep = 'agent' | 'myself' | 'send' | 'validate';

/**
 * A draft is not the finish line.
 *
 * What this command produces is a document full of `<!-- TODO -->` — useful as input to an
 * agent, useless as a deliverable. Ending here without saying so hands the developer
 * homework and calls it done, so the first option is the one that actually finishes the
 * job.
 */
async function offerNextStep(cwd: string): Promise<number> {
  const step = await select<NextStep>({
    message: 'What now?',
    choices: [
      { value: 'agent', label: 'let my agent write it', hint: 'the TODOs are for it, not you' },
      { value: 'myself', label: "I'll fill it in by hand" },
      { value: 'validate', label: 'check it against the schema' },
      { value: 'send', label: 'send it somewhere' },
    ],
  });

  if (step === 'agent') {
    out();
    out(style.bold('In your coding agent, in this repository:'));
    out();
    out(`  ${style.cyan('/handoff')}          Claude Code, with the skills installed`);
    out(`  ${style.cyan('/handoff')}          Claude Desktop, with the MCP server connected`);
    out();
    out('The agent reads the change, decides what it means for the target, and rewrites');
    out('the draft into a real handoff. Connect it once with:');
    out();
    out(`  ${style.cyan('handoff install mcp')}           any MCP client, nothing installed globally`);
    out(`  ${style.cyan('handoff install claude-code')}   Claude Code skills`);
    return 0;
  }

  if (step === 'myself') {
    out();
    out(`Fill in every ${style.cyan('<!-- TODO -->')}, then run ${style.cyan('handoff validate <id> --strict')}.`);
    out(style.dim('docs/writing-good-handoffs.md is worth five minutes before you start.'));
    return 0;
  }

  const { validateCommand } = await import('../commands/inspect.ts');
  const { pickHandoff } = await import('./pick.ts');
  const entry = await pickHandoff(cwd, 'outgoing', 'Which one?');
  if (!entry) return 0;

  if (step === 'validate') {
    return validateCommand({ values: {}, positionals: [entry.id] }, cwd);
  }

  const channel = await pickChannel(loadConfig(cwd).config, entry.handoff.frontmatter.targets);
  const values: ParsedArgs['values'] = { channel };
  if (channel === 'file') {
    values['to'] = await text({
      message: 'Write it where?',
      default: relative(cwd, join(handoffDirectory(loadConfig(cwd)), 'outbox')),
    });
  }
  return sendCommand({ values, positionals: [entry.id] }, cwd);
}
