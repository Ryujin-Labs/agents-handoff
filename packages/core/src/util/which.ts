import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

const cache = new Map<string, string | null>();

/**
 * Find an executable on PATH without spawning anything.
 *
 * Probing with `spawnSync('gh', ['--version'])` is the obvious way and the wrong one: it
 * pays a full process start every time availability is checked, and availability is checked
 * whenever delivery options are listed. A stat over PATH answers the same question — is the
 * binary there — for a rounding error, and anything that would only surface by running it
 * (a bad install, an expired login) surfaces at send time with a real error message.
 *
 * Memoized because PATH does not change inside one process.
 */
export function which(command: string): string | null {
  const cached = cache.get(command);
  if (cached !== undefined) return cached;

  const found = search(command);
  cache.set(command, found);
  return found;
}

function search(command: string): string | null {
  const path = process.env['PATH'];
  if (!path) return null;
  const extensions =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';')
      : [''];

  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, command + extension);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here, or not executable. Keep looking.
      }
    }
  }
  return null;
}

/** Exposed for tests, which need a clean slate between PATH manipulations. */
export function clearWhichCache(): void {
  cache.clear();
}
