import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  findSecrets,
  analyzeReceived,
  blockingStorageErrors,
  handoffDirectory,
  HandoffStore,
  loadConfig,
  parseHandoff,
  renderReceiveBrief,
  validateHandoff,
} from 'ryujin-handoff-core';
import { boolOption, stringOption, type OptionSpec, type ParsedArgs } from '../args.ts';
import { displayPath, err, jsonOut, out, printValidation, style } from '../ui.ts';

export const receiveOptions: Record<string, OptionSpec> = {
  as: { type: 'string', short: 'a', describe: 'Which consumer this repository is (mobile, web, ...)', placeholder: '<target>' },
  'no-store': { type: 'boolean', describe: 'Do not copy the handoff into .handoff/inbox' },
  json: { type: 'boolean', describe: 'Emit the analysis as JSON' },
  quiet: { type: 'boolean', describe: 'Only print errors' },
};

/**
 * Read a handoff someone sent you and render what it means here.
 *
 * The output is reordered relative to the document: `Required Actions` first, narrowed to
 * this repository's target when the sender split them. An agent given the raw file has to
 * work out which half applies to it, and gets it wrong often enough to matter.
 */
export async function receiveCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const ref = args.positionals[0];
  if (!ref) {
    err('Usage: handoff receive <path-to-handoff.md> [--as <target>]');
    return 1;
  }

  const path = resolvePath(ref, cwd);
  if (!path) {
    err(`Cannot read "${ref}". Pass a path to a HANDOFF.md file.`);
    return 1;
  }

  const source = readFileSync(path, 'utf8');
  let handoff;
  try {
    handoff = parseHandoff(source);
  } catch (error) {
    err(`${style.red('error')} ${(error as Error).message}`);
    err('This file is not a v1 handoff. It may be plain Markdown, or the frontmatter may be malformed.');
    return 1;
  }

  const loaded = loadConfig(cwd);
  // `identity` is who this repository is; `defaultTarget` is who it sends to. Falling back
  // to the latter would make a backend whose default is `mobile` claim to be mobile.
  const as = stringOption(args, 'as') ?? loaded.config.identity;
  const analysis = analyzeReceived(handoff, { as, project: loaded.config.project });

  // Storing is gated on the document conforming, and the id never picks the path: both are
  // decisions about a file another team wrote. See `blockingStorageErrors`.
  const blocking = blockingStorageErrors(analysis.validation);
  // A credential in someone else's handoff is their leak; filing it here would commit it
  // into this repository as well. Read it, do not keep it.
  const secrets = findSecrets(source);
  let storedAt: string | null = null;
  let storedAs: string | null = null;
  let renamedFrom: string | null = null;
  let renamedBecause: string | null = null;
  if (!boolOption(args, 'no-store') && blocking.length === 0 && secrets.length === 0) {
    const store = new HandoffStore(handoffDirectory(loaded));
    const saved = store.saveIncoming(handoff);
    storedAt = saved.path;
    storedAs = saved.id;
    renamedFrom = saved.renamedFrom;
    renamedBecause = saved.renamedBecause;
  }

  if (boolOption(args, 'json')) {
    jsonOut({
      id: handoff.frontmatter.id,
      source: path,
      stored_at: storedAt,
      stored_as: storedAs,
      renamed_from: renamedFrom,
      not_stored: storedAt ? null : [...blocking.map((issue) => issue.code), ...(secrets.length ? ['credential'] : [])],
      secrets,
      applies: analysis.applies,
      applies_reason: analysis.appliesReason,
      breaking: handoff.frontmatter.breaking,
      stale: analysis.stale,
      valid: analysis.validation.ok,
      errors: analysis.validation.errors,
      warnings: analysis.validation.warnings,
      actions_for_target: analysis.actionsForTarget,
      brief: renderReceiveBrief(analysis, { project: loaded.config.project }),
    });
    return analysis.validation.ok ? 0 : 1;
  }

  if (!analysis.validation.ok) {
    printValidation(validateHandoff(handoff), { quiet: true });
    err(style.yellow('This handoff does not conform to the v1 schema; reading it anyway.'));
    err('');
  }

  out(renderReceiveBrief(analysis, { project: loaded.config.project }).trimEnd());

  if (!boolOption(args, 'quiet')) {
    err('');
    if (storedAt) {
      err(style.dim(`Copy stored at ${displayPath(storedAt, cwd)}`));
      if (renamedFrom) {
        err(
          style.dim(
            renamedBecause === 'taken'
              ? `Filed as ${storedAs}: a handoff from another sender already uses "${renamedFrom}".`
              : `Filed as ${storedAs}: the id it declared cannot be a directory name.`,
          ),
        );
      }
    } else if (secrets.length > 0) {
      for (const finding of secrets) {
        err(`${style.red('secret')} line ${finding.line}: possible ${finding.kind} (${finding.preview})`);
      }
      err(style.yellow('Not stored: it contains what looks like a credential. Tell the sender to rotate it and send a clean copy.'));
    } else if (blocking.length > 0) {
      err(style.yellow('Not stored: this document does not conform to the v1 schema.'));
    }
  }
  return 0;
}

function resolvePath(ref: string, cwd: string): string | null {
  const candidates = [resolve(cwd, ref), resolve(cwd, ref, 'HANDOFF.md')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  // Also accept an id already stored in the inbox, so `receive` is re-runnable.
  const loaded = loadConfig(cwd);
  const inbox = join(handoffDirectory(loaded), 'inbox', ref, 'HANDOFF.md');
  return existsSync(inbox) ? inbox : null;
}
