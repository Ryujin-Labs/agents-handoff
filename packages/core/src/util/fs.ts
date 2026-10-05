import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function readTextIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function writeTextFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

/**
 * A directory for copies made to be attached or handed on, which keeps itself out of git.
 *
 * Every handoff is stored as `HANDOFF.md`, so a copy named after its id is made for sending.
 * Committed, that copy would drift from the original; ignored by a file inside the
 * directory itself, it stays local whatever the repository's own `.gitignore` says.
 */
export function prepareOutbox(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '# Copies made for attaching to a message.\n*\n', 'utf8');
  return dir;
}

export function readJsonIfExists<T>(path: string): T | null {
  const text = readTextIfExists(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * Walk up from `startDir` looking for a directory containing `marker`.
 * Returns the containing directory, or null when the filesystem root is reached.
 */
export function findUp(marker: string, startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, marker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Directory of the package containing the given module URL. */
export function packageRootOf(moduleUrl: string): string {
  const start = dirname(fileURLToPath(moduleUrl));
  const root = findUp('package.json', start);
  if (!root) throw new Error(`Could not locate a package root above ${start}`);
  return root;
}
