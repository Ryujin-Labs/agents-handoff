import {
  briefToJson,
  collectChangeContext,
  loadConfig,
  parseTargets,
  renderBrief,
} from 'ryujin-handoff-core';
import {
  boolOption,
  intOption,
  listOption,
  stringOption,
  type OptionSpec,
  type ParsedArgs,
} from '../args.ts';
import { jsonOut, out } from '../ui.ts';

/** Flags shared by `context` and `create`, since both select a revision the same way. */
export const revisionOptions: Record<string, OptionSpec> = {
  target: { type: 'string', short: 't', describe: 'Consumer this is for (mobile, web, sdk, ...)', placeholder: '<name>' },
  note: { type: 'string', short: 'n', describe: 'What you want the handoff to say', placeholder: '<text>' },
  base: { type: 'string', short: 'b', describe: 'Compare against this ref instead of the inferred trunk', placeholder: '<ref>' },
  commits: { type: 'string', short: 'c', describe: 'Describe the last N commits', placeholder: '<n>' },
  since: { type: 'string', short: 's', describe: 'Describe commits since a date expression', placeholder: '<when>' },
  staged: { type: 'boolean', describe: 'Only staged changes' },
  working: { type: 'boolean', describe: 'Only uncommitted working-tree changes' },
  paths: {
    type: 'string',
    short: 'p',
    multiple: true,
    describe: 'Limit the change to these paths (repeatable)',
    placeholder: '<path>',
  },
};

/** Path filters, split so `--paths "a b"` and repeated `--paths` both work. */
export function pathsFrom(args: ParsedArgs): string[] {
  return listOption(args, 'paths').flatMap((entry) => entry.split(/[\s,]+/)).filter(Boolean);
}

export const contextOptions: Record<string, OptionSpec> = {
  ...revisionOptions,
  json: { type: 'boolean', describe: 'Emit the brief as JSON instead of Markdown' },
};

/**
 * Print everything deterministic we know about the current change.
 *
 * This is the command a coding agent runs. It contains no reasoning at all, by design: the
 * agent supplies that, and keeping the two apart is what lets the same context feed Claude
 * Code, another agent, or a developer with no agent at all.
 */
export async function contextCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const loaded = loadConfig(cwd);
  const targets = parseTargets(stringOption(args, 'target') ?? loaded.config.defaultTarget);

  const context = collectChangeContext({
    cwd,
    loaded,
    targets,
    note: stringOption(args, 'note'),
    base: stringOption(args, 'base'),
    commits: intOption(args, 'commits'),
    since: stringOption(args, 'since'),
    staged: boolOption(args, 'staged'),
    working: boolOption(args, 'working'),
    paths: pathsFrom(args),
  });

  if (boolOption(args, 'json')) {
    jsonOut(briefToJson(context));
  } else {
    out(renderBrief(context).trimEnd());
  }

  // A brief with no changes is not an error — the developer may simply be on the wrong
  // branch — but it is worth a non-zero exit so a script can notice.
  return context.changedFiles.length === 0 ? 2 : 0;
}
