import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  findSecrets,
  handoffDirectory,
  HandoffStore,
  loadConfig,
  serializeHandoff,
  validateHandoffSource,
  type Direction,
} from 'agents-handoff-core';
import { boolOption, stringOption, type OptionSpec, type ParsedArgs } from '../args.ts';
import { displayPath, err, heading, jsonOut, keyValue, out, printValidation, style } from '../ui.ts';

export const listOptions: Record<string, OptionSpec> = {
  inbox: { type: 'boolean', describe: 'List received handoffs instead of created ones' },
  all: { type: 'boolean', describe: 'List both created and received handoffs' },
  json: { type: 'boolean', describe: 'Emit JSON' },
};

export const showOptions: Record<string, OptionSpec> = {
  raw: { type: 'boolean', describe: 'Print the Markdown exactly as stored' },
  json: { type: 'boolean', describe: 'Emit the parsed handoff as JSON' },
  section: { type: 'string', describe: 'Print only one section', placeholder: '<title>' },
};

export const validateOptions: Record<string, OptionSpec> = {
  strict: { type: 'boolean', describe: 'Treat warnings as failures' },
  quiet: { type: 'boolean', describe: 'Only print errors' },
  json: { type: 'boolean', describe: 'Emit JSON' },
};

export async function listCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const loaded = loadConfig(cwd);
  const store = new HandoffStore(handoffDirectory(loaded));
  const direction: Direction | 'all' = boolOption(args, 'all')
    ? 'all'
    : boolOption(args, 'inbox')
      ? 'inbox'
      : 'outgoing';
  const { handoffs, broken } = store.list(direction);

  if (boolOption(args, 'json')) {
    jsonOut({
      handoffs: handoffs.map((entry) => ({
        id: entry.id,
        direction: entry.direction,
        path: entry.path,
        title: entry.handoff.title,
        status: entry.handoff.frontmatter.status,
        breaking: entry.handoff.frontmatter.breaking,
        targets: entry.handoff.frontmatter.targets,
        created_at: entry.handoff.frontmatter.created_at,
      })),
      broken,
    });
    return 0;
  }

  if (handoffs.length === 0 && broken.length === 0) {
    out(style.dim(`No handoffs in ${displayPath(store.directory, cwd)}.`));
    out(`Create one with ${style.cyan('handoff create --target <who>')}.`);
    return 0;
  }

  for (const entry of handoffs) {
    const fm = entry.handoff.frontmatter;
    const flags = [
      fm.breaking ? style.red('breaking') : '',
      fm.status !== 'ready' ? style.dim(fm.status) : '',
      direction === 'all' ? style.dim(entry.direction) : '',
    ]
      .filter(Boolean)
      .join(' ');
    const targets = fm.targets.length > 0 ? style.cyan(fm.targets.join(',')) : style.dim('any');
    out(`${style.bold(entry.id)}  ${targets}  ${flags}`);
    out(`  ${entry.handoff.title}`);
  }

  for (const entry of broken) {
    err(`${style.red('unparseable')} ${entry.id}: ${entry.error}`);
  }
  return 0;
}

export async function showCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const ref = args.positionals[0];
  if (!ref) {
    err('Usage: handoff show <id|path>');
    return 1;
  }
  const loaded = loadConfig(cwd);
  const store = new HandoffStore(handoffDirectory(loaded));
  const found = store.resolveRef(ref, cwd);
  if (!found) {
    err(`No handoff matching "${ref}". Run ${style.cyan('handoff list --all')} to see what exists.`);
    return 1;
  }

  const section = stringOption(args, 'section');
  if (section) {
    const match = found.handoff.sections.find(
      (entry) => entry.title.toLowerCase() === section.toLowerCase(),
    );
    if (!match) {
      err(`No section "${section}" in ${found.id}.`);
      return 1;
    }
    out(match.content);
    return 0;
  }

  if (boolOption(args, 'json')) {
    jsonOut({ id: found.id, path: found.path, direction: found.direction, ...found.handoff, raw: undefined });
    return 0;
  }

  if (boolOption(args, 'raw')) {
    out(readFileSync(found.path, 'utf8').trimEnd());
    return 0;
  }

  const fm = found.handoff.frontmatter;
  heading(found.handoff.title);
  keyValue('id', found.id);
  keyValue('path', displayPath(found.path, cwd));
  keyValue('from', `${fm.source.project}${fm.source.branch ? ` (${fm.source.branch})` : ''}`);
  keyValue('targets', fm.targets.join(', ') || '(any consumer)');
  keyValue('status', fm.status);
  keyValue('breaking', fm.breaking ? style.red('yes') : 'no');
  keyValue('created', fm.created_at);
  out();
  out(serializeHandoff(found.handoff).replace(/^---[\s\S]*?\n---\n/, '').trim());
  return 0;
}

export async function validateCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const ref = args.positionals[0];
  const source = ref ? sourceFor(ref, cwd) : null;
  if (source === null) {
    const message = `No handoff matching "${ref ?? ''}". Pass an id or a path to a .md file.`;
    if (boolOption(args, 'json')) jsonOut({ path: null, ok: false, error: message });
    else err(message);
    return 1;
  }

  const result = validateHandoffSource(source.text);
  const secrets = findSecrets(source.text);

  if (boolOption(args, 'json')) {
    // One verdict for both output modes: CI reads the exit code, and a scripted check that
    // passes a credential or a --strict warning the human-readable run would fail on is a
    // check that does not check.
    const ok =
      result.ok &&
      secrets.length === 0 &&
      (!boolOption(args, 'strict') || result.warnings.length === 0);
    jsonOut({
      path: source.path,
      ok,
      errors: result.errors,
      warnings: result.warnings,
      secrets,
    });
    return ok ? 0 : 1;
  }

  const ok = printValidation(result, { quiet: boolOption(args, 'quiet') });
  for (const finding of secrets) {
    err(`${style.red('secret')} line ${finding.line}: possible ${finding.kind} (${finding.preview})`);
  }

  if (!ok || secrets.length > 0) return 1;
  if (boolOption(args, 'strict') && result.warnings.length > 0) {
    err(`${result.warnings.length} warning(s) with --strict.`);
    return 1;
  }
  if (!boolOption(args, 'quiet')) {
    out(`${style.green('valid')} ${displayPath(source.path, cwd)}`);
  }
  return 0;
}

function sourceFor(ref: string, cwd: string): { text: string; path: string } | null {
  const direct = resolve(cwd, ref);
  // A file, not a directory: a directory without a HANDOFF.md in it is not a handoff, and
  // reading one threw EISDIR past the --json output.
  if (existsSync(direct) && statSync(direct).isFile()) {
    return { text: readFileSync(direct, 'utf8'), path: direct };
  }
  const loaded = loadConfig(cwd);
  const store = new HandoffStore(handoffDirectory(loaded));
  const found = store.resolveRef(ref, cwd);
  return found ? { text: readFileSync(found.path, 'utf8'), path: found.path } : null;
}
