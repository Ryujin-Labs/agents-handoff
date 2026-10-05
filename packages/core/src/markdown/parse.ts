import { HANDOFF_VERSION } from '../constants.ts';
import type { Handoff, HandoffFrontmatter, HandoffLink, HandoffSource } from '../types.ts';
import type { Status } from '../constants.ts';
import { COERCED_KEYS } from './declared.ts';
import { FrontmatterParseError, parseFrontmatterYaml, splitFrontmatter } from './frontmatter.ts';
import { parseBody } from './sections.ts';

export class HandoffParseError extends Error {
  override readonly name = 'HandoffParseError';
}

/** Frontmatter keys we understand; anything else is preserved under `extra`. */
const KNOWN_KEYS = new Set([
  'handoff_version',
  'id',
  'title',
  'created_at',
  'status',
  'breaking',
  'source',
  'targets',
  'change_type',
  'author',
  'generated_by',
  'supersedes',
  'expires_at',
  'links',
]);

/**
 * Parse a handoff document.
 *
 * This is intentionally permissive about *values*: it converts what it can and leaves the
 * rest for {@link validateHandoff} to report. It throws only when the document has no
 * usable structure at all, because there is nothing meaningful to hand back in that case.
 */
export function parseHandoff(source: string): Handoff {
  const split = splitFrontmatter(source);
  if (split.yaml === null) {
    throw new HandoffParseError(
      'missing YAML frontmatter: a handoff must start with a `---` fence on line 1',
    );
  }

  let record: Record<string, unknown>;
  try {
    record = parseFrontmatterYaml(split.yaml);
  } catch (error) {
    if (error instanceof FrontmatterParseError) throw new HandoffParseError(error.message);
    throw error;
  }

  const body = parseBody(split.body);
  const frontmatter = toFrontmatter(record);

  return {
    frontmatter,
    title: frontmatter.title ?? body.title ?? '',
    bodyTitle: body.title,
    h1Count: body.h1Count,
    sections: body.sections,
    preamble: body.preamble,
    raw: source,
  };
}

function toFrontmatter(record: Record<string, unknown>): HandoffFrontmatter {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!KNOWN_KEYS.has(key)) extra[key] = value;
  }

  // Only keys the document actually wrote go in, so presence is `key in declared` rather
  // than a value test: `breaking:` with nothing after it is present, and is not a boolean.
  const declared: Record<string, unknown> = {};
  for (const key of COERCED_KEYS) {
    if (Object.hasOwn(record, key)) declared[key] = record[key];
  }

  const frontmatter: HandoffFrontmatter = {
    handoff_version: typeof record['handoff_version'] === 'number'
      ? record['handoff_version']
      : Number.NaN,
    id: asString(record['id']) ?? '',
    created_at: asString(record['created_at']) ?? '',
    status: (asString(record['status']) ?? '') as Status,
    // The conservative reading: anything that is not a YAML `true` leaves the toolchain
    // treating the change as non-breaking. It is the validator, reading `declared`, that
    // rejects the document instead of letting that default stand for an answer.
    breaking: record['breaking'] === true,
    source: toSource(record['source']),
    targets: asStringArray(record['targets']),
    change_type: asStringArray(record['change_type']),
    declared,
  };

  // Timestamps stay verbatim: YAML 1.2 has no timestamp type, so they arrive as strings
  // and rewriting them would make round-tripping lossy for no benefit.
  const expiresAt = asString(record['expires_at']);
  if (expiresAt !== null) frontmatter.expires_at = expiresAt;

  assignIfString(frontmatter, 'title', record['title']);
  assignIfString(frontmatter, 'author', record['author']);
  assignIfString(frontmatter, 'generated_by', record['generated_by']);
  assignIfString(frontmatter, 'supersedes', record['supersedes']);

  const links = toLinks(record['links']);
  if (links) frontmatter.links = links;
  if (Object.keys(extra).length > 0) frontmatter.extra = extra;

  return frontmatter;
}

function assignIfString<K extends 'title' | 'author' | 'generated_by' | 'supersedes'>(
  frontmatter: HandoffFrontmatter,
  key: K,
  value: unknown,
): void {
  const text = asString(value);
  if (text !== null) frontmatter[key] = text;
}

/** Keys of `source` this implementation understands; anything else is preserved verbatim. */
const KNOWN_SOURCE_KEYS = new Set(['project', 'repo', 'branch', 'commit', 'range']);

function toSource(value: unknown): HandoffSource {
  if (!isRecord(value)) return { project: '' };
  const source: HandoffSource = { project: asString(value['project']) ?? '' };
  for (const key of ['repo', 'branch', 'commit', 'range'] as const) {
    const text = asString(value[key]);
    if (text !== null) source[key] = text;
  }

  // `source` is a mapping like the frontmatter itself, so it gets the same promise: an
  // `x-` extension nested here survives a round trip instead of being quietly deleted.
  const extra: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!KNOWN_SOURCE_KEYS.has(key)) extra[key] = entry;
  }
  if (Object.keys(extra).length > 0) source.extra = extra;

  return source;
}

function toLinks(value: unknown): HandoffLink[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const links: HandoffLink[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const url = asString(entry['url']);
    if (url === null) continue;
    links.push({ label: asString(entry['label']) ?? url, url });
  }
  return links.length > 0 ? links : undefined;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Accept both `targets: [a, b]` and the common shorthand `targets: a`. */
function asStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map((entry) => asString(entry)).filter((entry): entry is string => entry !== null);
  }
  const single = asString(value);
  return single === null ? [] : [single];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when a string parses as a handoff of a version this implementation understands. */
export function isSupportedHandoff(source: string): boolean {
  try {
    return parseHandoff(source).frontmatter.handoff_version === HANDOFF_VERSION;
  } catch {
    return false;
  }
}
