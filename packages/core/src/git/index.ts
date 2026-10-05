import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { run } from '../util/exec.ts';

/** Resolve symlinks, through the nearest existing ancestor when the path does not exist yet. */
function realPath(path: string): string {
  // A path that does not exist yet resolves through its nearest existing ancestor, so a
  // file about to be written compares equal to the resolved repository root. Falling back
  // to the unresolved input made `/var/…` and `/private/var/…` look like different places.
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

export interface Commit {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'other';

export interface ChangedFile {
  path: string;
  status: FileStatus;
  /** Previous path, for renames and copies. */
  previousPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** How the set of changes under discussion was selected. */
export interface Revision {
  /** Argument passed to `git diff`, e.g. `main..HEAD`, `HEAD~5`, or `HEAD` for the tree. */
  spec: string;
  /**
   * Argument passed to `git log`, when it cannot be the diff spec.
   *
   * `git diff A...B` is the merge-base diff — B's side only — but `git log A...B` is the
   * symmetric difference and also lists everything that landed on A. Reusing one spec for
   * both puts other people's trunk commits in the brief as the content of this handoff.
   * Defaults to {@link spec} when the two agree; read it through {@link commitRange}.
   */
  logSpec?: string;
  /** Human-readable explanation, shown in the context brief. */
  description: string;
  /** Whether uncommitted working-tree changes are included. */
  includesWorkingTree: boolean;
  /** When set, only these paths are part of the change. */
  paths?: string[];
}

export interface RepoInfo {
  root: string;
  branch: string | null;
  head: Commit | null;
  remoteUrl: string | null;
  /** `owner/name` when it could be derived from the remote. */
  slug: string | null;
  /** The remote's host, lower-cased: `github.com`, `gitlab.com`, a self-hosted name. */
  host: string | null;
  dirty: boolean;
}

// Git substitutes %x1f / %x1e with the ASCII unit and record separators. Splitting on
// control characters rather than a text marker means no commit message can break parsing.
const FIELD = '\u001f';
const RECORD = '\u001e';
const LOG_FORMAT = `${['%H', '%h', '%an', '%ae', '%aI', '%s', '%b'].join('%x1f')}%x1e`;

export class Git {
  /**
   * Commands that failed where failure is not a normal outcome.
   *
   * Most git failures here are expected — resolving a ref that does not exist, asking a
   * non-repository for its branch — and are handled by returning null. But a failed
   * `git diff` is different: it returns an empty file list, which reads downstream as
   * "nothing changed". Recording it lets the caller say "git failed" instead of quietly
   * reporting a clean tree that is not clean.
   */
  readonly failures: string[] = [];

  constructor(readonly cwd: string) {}

  private git(args: string[]): { ok: boolean; stdout: string; error?: string; timedOut?: boolean } {
    return run('git', args, { cwd: this.cwd });
  }

  /** Run a command whose failure should be surfaced rather than swallowed. */
  private gitOrRecord(args: string[]): { ok: boolean; stdout: string } {
    const result = this.git(args);
    if (!result.ok) {
      this.failures.push(`git ${args.slice(0, 2).join(' ')}: ${result.error ?? 'failed'}`);
    }
    return result;
  }

  isRepo(): boolean {
    const result = this.git(['rev-parse', '--is-inside-work-tree']);
    return result.ok && result.stdout.trim() === 'true';
  }

  root(): string | null {
    const result = this.git(['rev-parse', '--show-toplevel']);
    return result.ok ? result.stdout.trim() || null : null;
  }

  branch(): string | null {
    const result = this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!result.ok) return null;
    const name = result.stdout.trim();
    return name === 'HEAD' ? null : name;
  }

  remoteUrl(): string | null {
    const result = this.git(['remote', 'get-url', 'origin']);
    return result.ok ? result.stdout.trim() || null : null;
  }

  isDirty(): boolean {
    const result = this.git(['status', '--porcelain']);
    return result.ok && result.stdout.trim().length > 0;
  }

  /** Paths with uncommitted changes, tracked or not, relative to the repository root. */
  uncommittedPaths(): string[] {
    const result = this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!result.ok) return [];
    const entries = result.stdout.split('\0').filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index] ?? '';
      paths.push(entry.slice(3));
      // With -z a rename or copy — staged or in the worktree — is followed by its source
      // path as an entry of its own.
      if (/[RC]/.test(entry.slice(0, 2))) index += 1;
    }
    return paths;
  }

  hasCommits(): boolean {
    return this.git(['rev-parse', '--verify', '--quiet', 'HEAD']).ok;
  }

  info(): RepoInfo | null {
    if (!this.isRepo()) return null;
    const remoteUrl = this.remoteUrl();
    return {
      root: this.root() ?? this.cwd,
      branch: this.branch(),
      head: this.hasCommits() ? (this.commits('HEAD', 1)[0] ?? null) : null,
      remoteUrl,
      slug: remoteUrl ? repoSlug(remoteUrl) : null,
      host: remoteUrl ? repoHost(remoteUrl) : null,
      dirty: this.isDirty(),
    };
  }

  /** Resolve a ref to a full SHA, or null when it does not exist. */
  resolve(ref: string): string | null {
    const result = this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return result.ok ? result.stdout.trim() || null : null;
  }

  /**
   * Best guess at the branch this work forked from: the remote's default branch when it is
   * known, otherwise the first conventional trunk name that exists.
   */
  defaultBaseRef(): string | null {
    const symbolic = this.git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    if (symbolic.ok) {
      const name = symbolic.stdout.trim().replace('refs/remotes/', '');
      if (name && this.resolve(name)) return name;
    }
    for (const candidate of ['origin/main', 'origin/master', 'main', 'master', 'develop']) {
      if (this.resolve(candidate)) return candidate;
    }
    return null;
  }

  /** Merge base of two refs, used to diff a branch against its fork point. */
  mergeBase(a: string, b: string): string | null {
    const result = this.git(['merge-base', a, b]);
    return result.ok ? result.stdout.trim() || null : null;
  }

  /**
   * Hash of the empty tree, the only honest "before" side for a range that reaches back
   * past the root commit.
   *
   * Asked of git rather than hardcoded because the value differs between SHA-1 and
   * SHA-256 repositories. Stdin is closed for every command we run, so `--stdin` hashes
   * nothing, which is exactly the input we want.
   */
  emptyTree(): string | null {
    const result = this.git(['hash-object', '-t', 'tree', '--stdin']);
    return result.ok ? result.stdout.trim() || null : null;
  }

  commits(spec: string, limit: number): Commit[] {
    const result = this.git(['log', `--max-count=${limit}`, `--format=${LOG_FORMAT}`, spec, '--']);
    return result.ok ? parseLog(result.stdout) : [];
  }

  /** Commits touching specific paths, newest first. Used for historical handoffs. */
  logForPaths(paths: string[], limit: number, since?: string): Commit[] {
    const args = ['log', `--max-count=${limit}`, `--format=${LOG_FORMAT}`];
    if (since) args.push(`--since=${since}`);
    args.push('--', ...paths);
    const result = this.git(args);
    return result.ok ? parseLog(result.stdout) : [];
  }

  /**
   * Changed files for a revision, with line counts.
   *
   * `--numstat` and `--name-status` are merged because neither alone gives both the rename
   * information and the line counts the brief needs.
   */
  changedFiles(revision: Revision): ChangedFile[] {
    const scope = pathArgs(revision);
    // Collected first, and returned even when the diff itself fails: these are the files
    // the diff was never able to describe in the first place.
    const untracked = this.untrackedFiles(revision);
    const numstat = this.gitOrRecord([
      'diff',
      '--numstat',
      '--find-renames',
      ...diffArgs(revision),
      ...scope,
    ]);
    if (!numstat.ok) return untracked;
    const nameStatus = this.git([
      'diff',
      '--name-status',
      '--find-renames',
      ...diffArgs(revision),
      ...scope,
    ]);

    const statuses = new Map<string, { status: FileStatus; previousPath?: string }>();
    if (nameStatus.ok) {
      for (const line of nameStatus.stdout.split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        const code = parts[0] ?? '';
        const status = statusFromCode(code);
        if (code.startsWith('R') || code.startsWith('C')) {
          const from = parts[1];
          const to = parts[2];
          if (to) statuses.set(to, from ? { status, previousPath: from } : { status });
        } else {
          const path = parts[1];
          if (path) statuses.set(path, { status });
        }
      }
    }

    const files: ChangedFile[] = [];
    for (const line of numstat.stdout.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const added = parts[0] ?? '';
      const removed = parts[1] ?? '';
      const parsed = parseNumstatPath(parts.slice(2).join('\t'));
      const meta = statuses.get(parsed.path);
      const binary = added === '-' || removed === '-';
      const file: ChangedFile = {
        path: parsed.path,
        status: meta?.status ?? (parsed.previousPath ? 'renamed' : 'modified'),
        additions: binary ? 0 : Number.parseInt(added, 10) || 0,
        deletions: binary ? 0 : Number.parseInt(removed, 10) || 0,
        binary,
      };
      const previous = parsed.previousPath ?? meta?.previousPath;
      if (previous) file.previousPath = previous;
      files.push(file);
    }

    const seen = new Set(files.map((file) => file.path));
    for (const file of untracked) {
      if (!seen.has(file.path)) files.push(file);
    }
    return files;
  }

  /**
   * Files git has never been told about.
   *
   * `git diff` cannot represent an untracked file in any form, so a change made entirely
   * of new files — a migration, a route, a `.env.example` — reads as an empty diff. Every
   * collector derives from this list, so omitting them does not produce a thinner brief,
   * it produces a confident description of the wrong change.
   */
  private untrackedFiles(revision: Revision): ChangedFile[] {
    if (!includesUntracked(revision)) return [];
    const listed = this.listUntracked(pathArgs(revision));
    const root = this.root() ?? this.cwd;
    return listed.map((path) => ({
      path,
      status: 'added' as const,
      ...fileStats(join(root, path)),
    }));
  }

  /** Untracked paths, relative to the repository root, honouring .gitignore. */
  private listUntracked(scope: string[]): string[] {
    const result = this.gitOrRecord([
      'ls-files',
      '--others',
      '--exclude-standard',
      '--full-name',
      ...scope,
    ]);
    if (!result.ok) return [];
    return result.stdout.split('\n').filter((line) => line.length > 0);
  }

  /**
   * Unified diff text for specific paths.
   *
   * Always scoped to an explicit path list, because the point of the collectors is to read
   * a little of the diff, never all of it.
   */
  diff(revision: Revision, paths: string[], contextLines = 0): string {
    if (paths.length === 0) return '';
    const result = this.gitOrRecord([
      'diff',
      `--unified=${contextLines}`,
      '--no-color',
      '--find-renames',
      ...diffArgs(revision),
      '--',
      ...paths,
    ]);
    return (result.ok ? result.stdout : '') + this.untrackedDiff(revision, paths);
  }

  /**
   * An "everything is new" diff for whichever of `paths` git has never seen.
   *
   * The collectors read the diff, not the working tree, so listing an untracked file
   * without this would report the new migration and stay silent about the column it
   * drops. Written directly rather than shelled out to `git diff --no-index`, which
   * costs one process per file and cannot take a path list.
   */
  private untrackedDiff(revision: Revision, paths: string[]): string {
    if (!includesUntracked(revision)) return '';
    const root = this.root() ?? this.cwd;
    let out = '';
    for (const path of this.listUntracked(['--', ...paths])) {
      const buffer = readBuffer(join(root, path));
      if (!buffer || isBinary(buffer)) continue;
      const text = buffer.toString('utf8');
      const lines = text === '' ? [] : stripTrailingNewline(text).split('\n');
      out += `diff --git a/${path} b/${path}\n@@ -0,0 +1,${lines.length} @@\n`;
      for (const line of lines) out += `+${line}\n`;
    }
    return out;
  }

  /** True when `path` exists in the tree at `ref`. */
  fileExistsAt(ref: string, path: string): boolean {
    return this.git(['cat-file', '-e', `${ref}:${path}`]).ok;
  }

  /** The tracking ref for a branch, e.g. `origin/staging`, when it exists. */
  remoteRef(branch: string): string | null {
    return this.upstream(branch)?.ref ?? null;
  }

  /**
   * The remote, and the branch on it, that `branch` tracks.
   *
   * Its name on the remote can differ from the local one — `git checkout -b wip
   * origin/feature/auth` — and so can the remote itself. A link built from the local name
   * and `origin` points at a branch the forge has never heard of.
   */
  upstream(branch: string): { remote: string; branch: string; ref: string } | null {
    const remote = this.git(['config', '--get', `branch.${branch}.remote`]);
    const merge = this.git(['config', '--get', `branch.${branch}.merge`]);
    const remoteName = remote.ok ? remote.stdout.trim() : '';
    const mergeRef = merge.ok ? merge.stdout.trim() : '';
    if (remoteName && remoteName !== '.' && mergeRef.startsWith('refs/heads/')) {
      const name = mergeRef.slice('refs/heads/'.length);
      const ref = `${remoteName}/${name}`;
      if (this.resolve(ref)) return { remote: remoteName, branch: name, ref };
    }
    const fallback = `origin/${branch}`;
    return this.resolve(fallback) ? { remote: 'origin', branch, ref: fallback } : null;
  }

  /** The URL of a named remote. */
  remoteUrlOf(name: string): string | null {
    const result = this.git(['remote', 'get-url', name]);
    return result.ok ? result.stdout.trim() || null : null;
  }

  /**
   * Path of a file relative to the repository root, for building a forge URL.
   *
   * Both sides are resolved through the filesystem first: `git rev-parse --show-toplevel`
   * reports the real path, while a caller usually holds the path it was given. On macOS
   * `/var` is a symlink to `/private/var`, so comparing the two verbatim decides that a
   * file inside the repository is outside it.
   */
  relativeToRoot(absolutePath: string): string | null {
    const root = this.root();
    if (!root) return null;
    const realRoot = realPath(root);
    const realFile = realPath(absolutePath);
    if (!realFile.startsWith(`${realRoot}/`)) return null;
    return realFile.slice(realRoot.length + 1);
  }

  /** Contents of a file at a ref, or null when it does not exist there. */
  showFile(ref: string, path: string): string | null {
    const result = this.git(['show', `${ref}:${path}`]);
    return result.ok ? result.stdout : null;
  }
}

/**
 * `git diff --numstat` writes renames as `old => new` or `dir/{old => new}/file`.
 * Unwind both forms back into a concrete pair of paths.
 */
export function parseNumstatPath(raw: string): { path: string; previousPath?: string } {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (braced) {
    const prefix = braced[1] ?? '';
    const suffix = braced[4] ?? '';
    const collapse = (middle: string): string =>
      `${prefix}${middle}${suffix}`.replace(/\/{2,}/g, '/');
    return { path: collapse(braced[3] ?? ''), previousPath: collapse(braced[2] ?? '') };
  }
  if (raw.includes(' => ')) {
    const [from, to] = raw.split(' => ');
    if (to) return { path: to, previousPath: from ?? '' };
  }
  return { path: raw };
}

function parseLog(stdout: string): Commit[] {
  return stdout
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const parts = record.split(FIELD);
      return {
        hash: parts[0] ?? '',
        shortHash: parts[1] ?? '',
        author: parts[2] ?? '',
        authorEmail: parts[3] ?? '',
        date: parts[4] ?? '',
        subject: parts[5] ?? '',
        body: (parts[6] ?? '').trim(),
      };
    });
}

/** The range `git log` should be asked for, which is not always the range git diff wants. */
export function commitRange(revision: Revision): string {
  return revision.logSpec ?? revision.spec;
}

/** Translate a {@link Revision} into the arguments `git diff` expects. */
function diffArgs(revision: Revision): string[] {
  return revision.spec === '' ? ['HEAD'] : [revision.spec];
}

/**
 * Whether untracked files belong to this revision.
 *
 * Only a diff taken against the working tree can have any: `--cached` describes the
 * index, where by definition nothing is untracked, and a commit range describes history.
 */
function includesUntracked(revision: Revision): boolean {
  return revision.includesWorkingTree && revision.spec !== '--cached';
}

function readBuffer(absolutePath: string): Buffer | null {
  try {
    return readFileSync(absolutePath);
  } catch {
    return null;
  }
}

/** The same test git uses: a NUL byte near the start of the file. */
function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

function stripTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/**
 * Line counts for a file git cannot diff, in the shape `--numstat` would have reported:
 * every line is an addition, and a binary file has no line counts at all.
 */
function fileStats(absolutePath: string): {
  additions: number;
  deletions: number;
  binary: boolean;
} {
  const buffer = readBuffer(absolutePath);
  if (!buffer) return { additions: 0, deletions: 0, binary: false };
  if (isBinary(buffer)) return { additions: 0, deletions: 0, binary: true };
  const body = stripTrailingNewline(buffer.toString('utf8'));
  return { additions: body === '' ? 0 : body.split('\n').length, deletions: 0, binary: false };
}

/** The pathspec half of a diff invocation, empty when the revision is not narrowed. */
function pathArgs(revision: Revision): string[] {
  return revision.paths?.length ? ['--', ...revision.paths] : [];
}

function statusFromCode(code: string): FileStatus {
  switch (code[0]) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    default:
      return 'other';
  }
}

/**
 * The host of an SSH or HTTPS remote URL, lower-cased.
 *
 * Needed wherever a URL is built from the remote: the path shape differs between forges,
 * and a GitHub-shaped URL on a GitLab remote is a dead link with a confident label on it.
 */
export function repoHost(remoteUrl: string): string | null {
  const cleaned = remoteUrl.trim();
  const ssh = /^[^@/]+@([^:/]+):/.exec(cleaned);
  if (ssh?.[1]) return ssh[1].toLowerCase();
  try {
    return new URL(cleaned).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Derive `owner/name` from an SSH or HTTPS remote URL. */
export function repoSlug(remoteUrl: string): string | null {
  const cleaned = remoteUrl.trim().replace(/\.git$/, '');
  const ssh = /^[^@/]+@[^:]+:(.+)$/.exec(cleaned);
  if (ssh?.[1]) return ssh[1];
  try {
    const url = new URL(cleaned);
    const path = url.pathname.replace(/^\/+/, '');
    return path || null;
  } catch {
    return null;
  }
}
