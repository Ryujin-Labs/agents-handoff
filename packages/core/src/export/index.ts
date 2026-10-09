import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, parse, resolve } from 'node:path';
import { parseHandoff } from '../markdown/parse.ts';
import { findSecrets } from '../redact.ts';
import { validateHandoff } from '../schema/validate.ts';
import { assertUsableId } from '../storage/index.ts';
import type { Handoff } from '../types.ts';

export interface ExportHandoffOptions {
  /** Complete original Markdown; exported without serialization or text changes. */
  markdown: string;
  cwd: string;
  /** Markdown `.md` file path, or an existing directory. Resolved from cwd. */
  outputPath?: string;
  /** Default directory for named copies. Defaults to `.handoff/exports` under cwd. */
  exportDir?: string;
  /** Original file, used to make an export to that same path a read-only operation. */
  sourcePath?: string;
}

export interface ExportHandoffResult {
  id: string;
  path: string;
  sourcePath?: string;
  markdown: string;
  /** True when identical bytes already existed at the requested path. */
  unchanged: boolean;
}

export class ExportHandoffError extends Error {
  override readonly name = 'ExportHandoffError';
}

/**
 * Write a complete Markdown handoff as a named local file.
 *
 * This operation has no network, application, clipboard, recipient, or delivery step.
 * Existing source files remain intact; only a copy of the same handoff may be refreshed.
 */
export function exportHandoff(options: ExportHandoffOptions): ExportHandoffResult {
  if (findSecrets(options.markdown).length > 0) {
    throw new ExportHandoffError('Cannot export a handoff containing a possible credential. Remove it first.');
  }
  let handoff: Handoff;
  try {
    handoff = parseHandoff(options.markdown);
    assertUsableId(handoff.frontmatter.id);
  } catch (error) {
    throw new ExportHandoffError(`Cannot export an invalid handoff: ${(error as Error).message}`);
  }
  const validation = validateHandoff(handoff);
  if (!validation.ok) {
    throw new ExportHandoffError(`Cannot export an invalid handoff: ${validation.errors.map((issue) => issue.message).join('; ')}`);
  }
  if (validation.warnings.some((issue) => issue.code === 'unfilled-template')) {
    throw new ExportHandoffError('Cannot export an unfinished scaffold. Fill in the handoff first.');
  }

  const cwd = resolve(options.cwd);
  const exportDir = resolve(cwd, options.exportDir ?? '.handoff/exports');
  let path = options.outputPath === undefined
    ? join(exportDir, `${handoff.frontmatter.id}.md`)
    : resolve(cwd, options.outputPath);
  rejectSymlinks(path, cwd);
  if (existsSync(path) && lstatSync(path).isDirectory()) {
    path = join(path, `${handoff.frontmatter.id}.md`);
    rejectSymlinks(path, cwd);
  }
  if (extname(path).toLowerCase() !== '.md') {
    throw new ExportHandoffError('Choose a Markdown output filename ending in .md.');
  }

  const sourcePath = options.sourcePath === undefined ? undefined : resolve(cwd, options.sourcePath);
  if (sourcePath) {
    let currentSource: string;
    try {
      currentSource = readFileSync(sourcePath, 'utf8');
    } catch {
      throw new ExportHandoffError('The source file is no longer readable. Read it again before exporting.');
    }
    if (currentSource !== options.markdown) {
      throw new ExportHandoffError('The source file changed since it was read. Read it again before exporting.');
    }
  }
  const result = (unchanged: boolean): ExportHandoffResult => ({
    id: handoff.frontmatter.id,
    path,
    ...(sourcePath ? { sourcePath } : {}),
    markdown: options.markdown,
    unchanged,
  });

  if (existsSync(path)) {
    if (!lstatSync(path).isFile()) throw new ExportHandoffError(`${path} is not a regular file.`);
    const existing = readFileSync(path, 'utf8');
    if (existing === options.markdown) return result(true);
    if (path === sourcePath) {
      throw new ExportHandoffError('The source file changed since it was read. Read it again before exporting.');
    }
    try {
      const previous = parseHandoff(existing);
      if (
        previous.frontmatter.id !== handoff.frontmatter.id ||
        previous.frontmatter.source.project !== handoff.frontmatter.source.project
      ) throw new Error('different handoff');
    } catch {
      throw new ExportHandoffError(`${path} already exists and is not a copy of this handoff. Choose another path.`);
    }
  }

  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  rejectSymlinks(path, cwd);
  if (directory === exportDir) {
    // Named copies are local output. Never replace an existing ignore file.
    try {
      writeFileSync(join(exportDir, '.gitignore'), '# Exported Markdown copies.\n*\n', { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  if (!existsSync(path)) {
    writeFileSync(path, options.markdown, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } else {
    // Rename a private sibling over the previous copy; never write through a leaf link.
    const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, options.markdown, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  return result(false);
}

/** Reject links beneath the project or top-level OS directories, including broken ones. */
function rejectSymlinks(path: string, cwd: string): void {
  const root = parse(path).root;
  let current = path;
  while (current !== root && current !== cwd) {
    // macOS's `/var` and `/tmp` are OS aliases. A selected cwd is also a trusted root;
    // the mutable directories below either must still not redirect an output write.
    if (dirname(current) === root && current !== path) break;
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new ExportHandoffError(`${current} is a symbolic link. Choose a regular output path.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    current = dirname(current);
  }
}
