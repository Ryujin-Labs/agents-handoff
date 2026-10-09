import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { HANDOFF_FILENAME, ID_PATTERN, INBOX_DIRNAME, LIMITS } from '../constants.ts';
import { parseHandoff } from '../markdown/parse.ts';
import { serializeHandoff } from '../markdown/serialize.ts';
import type { Handoff, Issue, ValidationResult } from '../types.ts';
import { writeTextFile } from '../util/fs.ts';
import { datePrefix, slugify } from '../util/slug.ts';

export type Direction = 'outgoing' | 'inbox';

export interface StoredHandoff {
  id: string;
  direction: Direction;
  /** Absolute path to the `HANDOFF.md` file. */
  path: string;
  /** Absolute path to the directory containing it. */
  dir: string;
  handoff: Handoff;
}

export interface BrokenHandoff {
  id: string;
  direction: Direction;
  path: string;
  error: string;
}

export interface IncomingSaveResult {
  /** Absolute path to the stored `HANDOFF.md`. */
  path: string;
  /** The id it was actually filed under. */
  id: string;
  /** The id the document asked for, when it could not be used. */
  renamedFrom: string | null;
  /**
   * Why it was filed under another id: the declared one cannot be a directory name, or a
   * handoff from a different sender already has it. Null when it kept its own id.
   */
  renamedBecause: 'unusable-id' | 'taken' | null;
}

export interface ListResult {
  handoffs: StoredHandoff[];
  /** Directories that look like handoffs but could not be parsed. */
  broken: BrokenHandoff[];
}

export class UnusableHandoffId extends Error {
  override readonly name = 'UnusableHandoffId';
}

/**
 * Whether an id can become a directory name inside the handoff directory.
 *
 * This is the schema's `id` rule doing a second job. The first job is telling a writer
 * their id is malformed; this one is refusing to let a document written elsewhere decide
 * where this machine writes files. `../../../etc` is a valid YAML string and a valid
 * relative path, and only the pattern stands between it and `writeTextFile`.
 */
export function isUsableId(id: string): boolean {
  return (
    typeof id === 'string' && id.length > 0 && id.length <= LIMITS.maxIdLength && ID_PATTERN.test(id)
  );
}

export function assertUsableId(id: string): void {
  if (isUsableId(id)) return;
  throw new UnusableHandoffId(
    `"${id}" is not a usable handoff id: it must match ${ID_PATTERN.source} and be at most ${LIMITS.maxIdLength} characters.`,
  );
}

/**
 * An id to file an incoming handoff under when its own is unusable.
 *
 * Derived from the title so a human recognises it, dated so it sorts with the others, and
 * suffixed with a hash of the id it replaces so two rejected documents cannot collide.
 */
export function derivedHandoffId(handoff: Handoff): string {
  const created = Date.parse(handoff.frontmatter.created_at ?? '');
  const date = datePrefix(Number.isNaN(created) ? new Date() : new Date(created));
  const digest = createHash('sha256')
    .update(`${handoff.frontmatter.id ?? ''}\n${handoff.title}`)
    .digest('hex')
    .slice(0, 8);
  return `${date}-${slugify(handoff.title)}-${digest}`;
}

/**
 * Validation errors that stop a document from being stored at all.
 *
 * A bad id is not one of them — the store can pick its own name, and {@link
 * HandoffStore.saveIncoming} does. Every other error means this is not a conforming
 * handoff, and a non-conforming handoff on disk is worse than none: the developer believes
 * they have one.
 */
export function blockingStorageErrors(validation: ValidationResult): Issue[] {
  return validation.errors.filter(
    (issue) => issue.code !== 'invalid-id' && issue.code !== 'missing-id',
  );
}

/**
 * Handoffs are stored one per directory, named by id, with no index file.
 *
 * The directory listing *is* the index. An index file would be a second source of truth
 * that drifts the first time someone deletes a folder by hand.
 */
export class HandoffStore {
  constructor(readonly directory: string) {}

  outgoingDir(): string {
    return this.directory;
  }

  inboxDir(): string {
    return join(this.directory, INBOX_DIRNAME);
  }

  dirFor(id: string, direction: Direction): string {
    assertUsableId(id);
    return join(direction === 'inbox' ? this.inboxDir() : this.outgoingDir(), id);
  }

  pathFor(id: string, direction: Direction): string {
    return join(this.dirFor(id, direction), HANDOFF_FILENAME);
  }

  exists(id: string, direction: Direction = 'outgoing'): boolean {
    // A lookup with an unusable id is a miss, not an error: `resolveRef` passes whatever
    // the developer typed through here before trying the other interpretations.
    if (!isUsableId(id)) return false;
    return existsSync(this.pathFor(id, direction));
  }

  ensure(): void {
    mkdirSync(this.directory, { recursive: true });
  }

  /** Write a handoff, creating its directory. Returns the file path. */
  save(handoff: Handoff, direction: Direction = 'outgoing'): string {
    // One file per handoff. Named copies are made only on an explicit Markdown export,
    // because a second stored copy would drift from the first after an edit.
    const path = this.pathFor(handoff.frontmatter.id, direction);
    writeTextFile(path, serializeHandoff(handoff));
    return path;
  }

  /**
   * File a handoff another team wrote.
   *
   * Its id arrived in a document nobody here controls, and an id becomes a directory name.
   * When it cannot be one, the copy is filed under a derived id rather than dropped: the
   * developer still wants the file, and the sender still gets told their id was wrong.
   */
  saveIncoming(handoff: Handoff): IncomingSaveResult {
    const original = handoff.frontmatter.id;
    const usable = isUsableId(original);
    // The same id from the same sender is a newer revision of that handoff. From anyone
    // else it is a different document that shares a name, and replacing the first would
    // lose one team's handoff without a word.
    const existing = usable ? this.read(original, 'inbox') : null;
    const taken =
      existing !== null &&
      existing.handoff.frontmatter.source.project !== handoff.frontmatter.source.project;
    if (usable && !taken) {
      return { path: this.save(handoff, 'inbox'), id: original, renamedFrom: null, renamedBecause: null };
    }
    const id = derivedHandoffId(handoff);
    // Renamed in the stored copy too: a document filed under one id and claiming another
    // is a trap for whoever reads it next.
    const renamed: Handoff = { ...handoff, frontmatter: { ...handoff.frontmatter, id } };
    return {
      path: this.save(renamed, 'inbox'),
      id,
      renamedFrom: original,
      renamedBecause: taken ? 'taken' : 'unusable-id',
    };
  }

  read(id: string, direction: Direction = 'outgoing'): StoredHandoff | null {
    if (!isUsableId(id)) return null;
    const path = this.pathFor(id, direction);
    if (!existsSync(path)) return null;
    const source = readFileSync(path, 'utf8');
    return {
      id,
      direction,
      path,
      dir: this.dirFor(id, direction),
      handoff: parseHandoff(source),
    };
  }

  list(direction: Direction | 'all' = 'all'): ListResult {
    const directions: Direction[] =
      direction === 'all' ? ['outgoing', 'inbox'] : [direction];
    const handoffs: StoredHandoff[] = [];
    const broken: BrokenHandoff[] = [];

    for (const dir of directions) {
      const base = dir === 'inbox' ? this.inboxDir() : this.outgoingDir();
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base)) {
        if (dir === 'outgoing' && entry === INBOX_DIRNAME) continue;
        const path = join(base, entry, HANDOFF_FILENAME);
        if (!existsSync(path) || !statSync(path).isFile()) continue;
        try {
          handoffs.push({
            id: entry,
            direction: dir,
            path,
            dir: join(base, entry),
            handoff: parseHandoff(readFileSync(path, 'utf8')),
          });
        } catch (error) {
          broken.push({ id: entry, direction: dir, path, error: (error as Error).message });
        }
      }
    }

    handoffs.sort((a, b) =>
      b.handoff.frontmatter.created_at.localeCompare(a.handoff.frontmatter.created_at),
    );
    return { handoffs, broken };
  }

  /**
   * Resolve a user-supplied reference: an id, a directory, or a path to a Markdown file.
   * Accepting all three means `handoff show` works with whatever the developer has to hand.
   */
  /**
   * A stored handoff by its id, or by an unambiguous part of one — and never by path.
   *
   * This is the lookup for callers whose argument comes from a model. Accepting a path here
   * let an "id" name any file the process could read, past the project boundary and the
   * refusal of secrets files. `ambiguous` lists the ids a part matched when it matched more
   * than one, so the caller can say which, instead of "no handoff matching".
   */
  lookup(ref: string): { found: StoredHandoff | null; ambiguous: string[] } {
    for (const direction of ['outgoing', 'inbox'] as const) {
      const found = this.read(ref, direction);
      if (found) return { found, ambiguous: [] };
    }
    const matches = ref.trim() ? this.list('all').handoffs.filter((entry) => entry.id.includes(ref)) : [];
    if (matches.length === 1) return { found: matches[0] ?? null, ambiguous: [] };
    return { found: null, ambiguous: matches.map((entry) => entry.id) };
  }

  /**
   * For a person at the command line: an id, a path to a handoff file, or an unambiguous
   * part of an id. Paths are fine here because the developer typed them.
   */
  resolveRef(ref: string, cwd: string): StoredHandoff | null {
    for (const direction of ['outgoing', 'inbox'] as const) {
      const found = this.read(ref, direction);
      if (found) return found;
    }

    const candidates = [resolve(cwd, ref), resolve(cwd, ref, HANDOFF_FILENAME)];
    for (const candidate of candidates) {
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      const dir = candidate.endsWith(HANDOFF_FILENAME)
        ? candidate.slice(0, -(HANDOFF_FILENAME.length + 1))
        : dirname(candidate);
      const handoff = parseHandoff(readFileSync(candidate, 'utf8'));
      return {
        id: handoff.frontmatter.id || basename(dir),
        direction: candidate.includes(`${INBOX_DIRNAME}/`) ? 'inbox' : 'outgoing',
        path: candidate,
        dir,
        handoff,
      };
    }

    return this.lookup(ref).found;
  }
}
