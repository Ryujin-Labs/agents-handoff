import { sessionIO } from './session.ts';
import { relative } from 'node:path';
import type { ValidationResult } from 'ryujin-handoff-core';

/**
 * Colour is opt-out via NO_COLOR and automatically off when stdout is not a TTY, so piping
 * `handoff show` into another tool yields clean text.
 */
const enabled =
  process.env['NO_COLOR'] === undefined &&
  process.env['TERM'] !== 'dumb' &&
  process.stdout.isTTY === true;

function wrap(open: number, close: number) {
  return (text: string): string => (enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text);
}

export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
};

/**
 * Everything the CLI prints goes through here.
 *
 * A session may supply a substitute stream, which is what lets a test drive an interactive
 * flow and read back everything the user would have seen. Without one these are just
 * stdout and stderr.
 */
export function out(line = ''): void {
  const io = sessionIO();
  if (io) io.output.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function err(line: string): void {
  const io = sessionIO();
  // A captured session folds both streams together: a test reads one transcript, in the
  // order the user would have seen it.
  if (io) io.output.write(`${line}\n`);
  else process.stderr.write(`${line}\n`);
}

export function heading(text: string): void {
  out(style.bold(text));
}

export function bullet(text: string): void {
  out(`  ${text}`);
}

export function keyValue(key: string, value: string, width = 14): void {
  out(`  ${style.dim(key.padEnd(width))} ${value}`);
}

/** Paths are shown relative to the cwd when that is shorter, which it usually is. */
export function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') && rel.length < path.length ? rel : path;
}

/** Print validation errors and warnings. Returns true when there were no errors. */
export function printValidation(result: ValidationResult, options: { quiet?: boolean } = {}): boolean {
  for (const issue of result.errors) {
    err(`${style.red('error')} ${issue.path ? style.dim(`[${issue.path}] `) : ''}${issue.message}`);
  }
  if (!options.quiet) {
    for (const issue of result.warnings) {
      err(`${style.yellow('warn')}  ${issue.path ? style.dim(`[${issue.path}] `) : ''}${issue.message}`);
    }
  }
  return result.errors.length === 0;
}

export function jsonOut(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}
