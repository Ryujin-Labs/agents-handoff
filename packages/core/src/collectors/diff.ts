/** One file's worth of a unified diff, reduced to the lines that changed. */
export interface FileDiff {
  path: string;
  previousPath?: string;
  added: string[];
  removed: string[];
}

/**
 * Parse `git diff --unified=0` output.
 *
 * This intentionally discards hunk headers and context: collectors care about *what text
 * appeared and disappeared*, not about line numbers. Keeping the parser this small is what
 * makes the heuristics on top of it cheap enough to run on every handoff.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) files.push(current);
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const before = match?.[1];
      const after = match?.[2] ?? before ?? '';
      current = { path: after, added: [], removed: [] };
      if (before && before !== after) current.previousPath = before;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('@@')) continue;
    if (line.startsWith('index ') || line.startsWith('similarity ')) continue;
    if (line.startsWith('rename from ')) {
      current.previousPath = line.slice('rename from '.length);
      continue;
    }
    if (line.startsWith('+')) current.added.push(line.slice(1));
    else if (line.startsWith('-')) current.removed.push(line.slice(1));
  }

  if (current) files.push(current);
  return files;
}

/**
 * Lines that were removed and not re-added anywhere in the same file.
 *
 * Reformatting and moving code produce huge numbers of paired add/remove lines. Comparing
 * on normalized whitespace filters most of that out, which is what makes removal-based
 * breaking-change detection tolerable instead of unusable.
 */
export function trulyRemoved(file: FileDiff): string[] {
  const added = new Set(file.added.map(normalize));
  return file.removed.filter((line) => line.trim() && !added.has(normalize(line)));
}

/** Lines that were added and did not merely replace an identical removed line. */
export function trulyAdded(file: FileDiff): string[] {
  const removed = new Set(file.removed.map(normalize));
  return file.added.filter((line) => line.trim() && !removed.has(normalize(line)));
}

function normalize(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}
