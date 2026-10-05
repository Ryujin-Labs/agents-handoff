import type { Handoff, HandoffFrontmatter } from '../types.ts';
import { tidyMarkdown } from '../util/text.ts';
import { declaredValue } from './declared.ts';
import { stringifyFrontmatterYaml } from './frontmatter.ts';

/**
 * Canonical frontmatter key order. Writing keys in a fixed order keeps generated handoffs
 * diff-friendly: regenerating one produces a minimal diff instead of a reshuffle.
 */
const KEY_ORDER = [
  'handoff_version',
  'id',
  'title',
  'created_at',
  'status',
  'breaking',
  'author',
  'generated_by',
  'source',
  'targets',
  'change_type',
  'supersedes',
  'expires_at',
  'links',
] as const;

export function frontmatterToRecord(frontmatter: HandoffFrontmatter): Record<string, unknown> {
  const source: Record<string, unknown> = { project: frontmatter.source.project };
  for (const key of ['repo', 'branch', 'commit', 'range'] as const) {
    const value = frontmatter.source[key];
    if (value !== undefined && value !== '') source[key] = value;
  }
  for (const [key, value] of Object.entries(frontmatter.source.extra ?? {})) {
    if (!(key in source)) source[key] = value;
  }

  const all: Record<string, unknown> = {
    handoff_version: frontmatter.handoff_version,
    id: frontmatter.id,
    title: frontmatter.title,
    created_at: frontmatter.created_at,
    status: frontmatter.status,
    breaking: declaredValue(frontmatter, 'breaking', frontmatter.breaking),
    author: frontmatter.author,
    generated_by: frontmatter.generated_by,
    source,
    targets: declaredValue(frontmatter, 'targets', frontmatter.targets),
    change_type: declaredValue(frontmatter, 'change_type', frontmatter.change_type),
    supersedes: frontmatter.supersedes,
    expires_at: frontmatter.expires_at,
    links: frontmatter.links,
  };

  const record: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    const value = all[key];
    if (value === undefined) continue;
    // `targets: []` and `change_type: []` are both meaningful: the spec requires the keys,
    // so an empty list says "no consumer named" / "not classified" and dropping either one
    // would turn a conforming document into one the validator rejects.
    if (key === 'links' && Array.isArray(value) && value.length === 0) continue;
    record[key] = value;
  }

  // Unknown keys are preserved so a round trip never silently drops information.
  for (const [key, value] of Object.entries(frontmatter.extra ?? {})) {
    if (!(key in record)) record[key] = value;
  }

  return record;
}

/** Render a handoff back to its Markdown representation. */
export function serializeHandoff(handoff: Handoff): string {
  const yaml = stringifyFrontmatterYaml(frontmatterToRecord(handoff.frontmatter));
  const parts: string[] = ['---', yaml, '---', ''];

  // The body's own H1 is body content, not a rendering of the frontmatter `title`. When the
  // two differ that is a warning for the writer to settle, and overwriting one with the
  // other here would settle it silently — in the direction the reader never sees, since a
  // pasted handoff shows the H1 and hides the frontmatter.
  const title = handoff.bodyTitle ?? handoff.title;
  if (title) parts.push(`# ${title}`, '');
  if (handoff.preamble.trim()) parts.push(handoff.preamble.trim(), '');

  for (const section of handoff.sections) {
    parts.push(`## ${section.title}`, '');
    if (section.content.trim()) parts.push(section.content.trim(), '');
  }

  return tidyMarkdown(parts.join('\n'));
}
