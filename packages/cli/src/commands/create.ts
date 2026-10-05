import { readFileSync } from 'node:fs';
import {
  collectChangeContext,
  findSecrets,
  handoffDirectory,
  HandoffStore,
  loadConfig,
  parseHandoff,
  parseTargets,
  scaffoldHandoff,
  serializeHandoff,
  uniqueId,
  validateHandoff,
  VERSION,
} from 'agents-handoff-core';
import {
  boolOption,
  intOption,
  stringOption,
  UsageError,
  type OptionSpec,
  type ParsedArgs,
} from '../args.ts';
import { displayPath, err, heading, jsonOut, keyValue, out, printValidation, style } from '../ui.ts';
import { pathsFrom, revisionOptions } from './context.ts';

export const createOptions: Record<string, OptionSpec> = {
  ...revisionOptions,
  title: { type: 'string', describe: 'Handoff title (default: derived from branch or commit)', placeholder: '<text>' },
  id: { type: 'string', describe: 'Explicit handoff id (default: YYYY-MM-DD-<slug>)', placeholder: '<id>' },
  author: { type: 'string', describe: 'Author name to record', placeholder: '<name>' },
  stdin: { type: 'boolean', describe: 'Read a complete handoff document from stdin instead of scaffolding' },
  print: { type: 'boolean', describe: 'Print the document instead of writing it' },
  json: { type: 'boolean', describe: 'Emit the result as JSON' },
  force: { type: 'boolean', describe: 'Overwrite an existing handoff with the same id' },
};

/**
 * Create a handoff.
 *
 * Two modes, and the split is the whole point of the design:
 *
 * - Default: scaffold a draft from git facts, with `<!-- TODO -->` markers where judgment
 *   is required. No model is involved, so this works offline, in CI, and for a developer
 *   who has no coding agent at all.
 * - `--stdin`: accept a finished document. This is how an agent that has already done the
 *   thinking stores its result through the same validation and storage path.
 */
export async function createCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const loaded = loadConfig(cwd);
  const store = new HandoffStore(handoffDirectory(loaded));
  const now = new Date();

  if (boolOption(args, 'stdin')) {
    return createFromStdin(args, cwd, store);
  }

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
    now,
  });

  const scaffoldArgs = {
    context,
    targets,
    now,
    generatedBy: `agents-handoff/${VERSION}`,
    ...(stringOption(args, 'title') !== undefined ? { title: stringOption(args, 'title') } : {}),
    ...(stringOption(args, 'id') !== undefined ? { id: stringOption(args, 'id') } : {}),
    ...(stringOption(args, 'author') !== undefined ? { author: stringOption(args, 'author') } : {}),
  };
  const handoff = scaffoldHandoff(scaffoldArgs);

  if (!stringOption(args, 'id') && !boolOption(args, 'force')) {
    handoff.frontmatter.id = uniqueId(handoff.frontmatter.id, (id) => store.exists(id));
  }

  if (boolOption(args, 'print')) {
    out(serializeHandoff(handoff).trimEnd());
    return 0;
  }

  if (store.exists(handoff.frontmatter.id) && !boolOption(args, 'force')) {
    err(`A handoff with id "${handoff.frontmatter.id}" already exists. Use --force or --id.`);
    return 1;
  }

  const path = store.save(handoff);

  if (boolOption(args, 'json')) {
    jsonOut({
      id: handoff.frontmatter.id,
      path,
      targets: handoff.frontmatter.targets,
      status: handoff.frontmatter.status,
      change_type: handoff.frontmatter.change_type,
      warnings: context.warnings,
    });
    return 0;
  }

  heading('Draft handoff created');
  keyValue('path', displayPath(path, cwd));
  keyValue('id', handoff.frontmatter.id);
  keyValue('targets', handoff.frontmatter.targets.join(', ') || style.dim('(any consumer)'));
  keyValue('revision', context.revision.spec || 'working tree');
  for (const warning of context.warnings) out(`  ${style.yellow('warn')} ${warning}`);

  out();
  out('This is a draft. Every `<!-- TODO -->` needs a human or agent decision:');
  out('  - what the change means for the target, not what the diff contains');
  out('  - whether it is actually breaking');
  out('  - what the receiver must do about it');
  out();
  out(`Then run ${style.cyan(`handoff validate ${handoff.frontmatter.id}`)}.`);
  return 0;
}

/** Store a complete document supplied on stdin, after validating it. */
async function createFromStdin(args: ParsedArgs, cwd: string, store: HandoffStore): Promise<number> {
  const source = await readStdin();
  if (!source.trim()) throw new UsageError('--stdin was given but nothing was piped in');

  const handoff = parseHandoff(source);
  const validation = validateHandoff(handoff);
  if (!printValidation(validation)) {
    err('Refusing to store a handoff that does not conform to the v1 schema.');
    return 1;
  }

  const secrets = findSecrets(source);
  if (secrets.length > 0) {
    for (const finding of secrets) {
      err(`${style.red('secret')} line ${finding.line}: possible ${finding.kind} (${finding.preview})`);
    }
    err('Refusing to store a handoff containing what looks like a credential.');
    return 1;
  }

  if (store.exists(handoff.frontmatter.id) && !boolOption(args, 'force')) {
    err(`A handoff with id "${handoff.frontmatter.id}" already exists. Use --force.`);
    return 1;
  }

  const path = store.save(handoff);
  if (boolOption(args, 'json')) {
    jsonOut({ id: handoff.frontmatter.id, path, warnings: validation.warnings });
  } else {
    out(`${style.green('Stored')} ${displayPath(path, cwd)}`);
  }
  return 0;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/** Read a handoff from a path, for commands that accept either a ref or a file. */
export function readFileOrThrow(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new UsageError(`cannot read ${path}`);
  }
}
