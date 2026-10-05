import { HANDOFF_VERSION, SECTIONS, type Status } from '../constants.ts';
import type { ChangeContext } from '../context/collect.ts';
import type { Handoff, HandoffFrontmatter, HandoffSection, HandoffSource } from '../types.ts';
import { buildHandoffId } from '../util/slug.ts';
import { unique } from '../util/text.ts';

/** The prose an author supplies, one entry per section. */
export interface HandoffBody {
  Summary: string;
  'Why This Matters': string;
  Changes: string;
  'Required Actions': string;
  Verification: string;
  'Instructions for Receiving Agent': string;
  'Breaking Changes'?: string;
  Contracts?: string;
  'Relevant Source'?: string;
  'Out of Scope'?: string;
  Notes?: string;
}

export interface ComposeOptions {
  context: ChangeContext;
  title: string;
  targets: string[];
  breaking: boolean;
  changeType: string[];
  body: HandoffBody;
  status?: Status;
  author?: string | undefined;
  generatedBy?: string | undefined;
  id?: string | undefined;
  now?: Date;
}

/**
 * Build a finished handoff from prose an agent wrote plus facts the repository supplied.
 *
 * This is the counterpart to {@link scaffoldHandoff}, and the difference matters. A
 * scaffold is homework: it hands a human a document full of `<!-- TODO -->`. This takes
 * the judgment an agent has already made and assembles the document around it, which is
 * what the workflow should actually produce.
 *
 * Splitting it this way also removes a class of error. The agent supplies only prose;
 * `handoff_version`, `id`, `created_at`, branch, commit and revision range all come from
 * git, so they cannot be misremembered, and the section headings are generated rather than
 * typed, so they cannot drift from the ones the validator matches on.
 */
export function composeHandoff(options: ComposeOptions): Handoff {
  const { context } = options;
  const now = options.now ?? new Date();
  const title = options.title.trim();
  const targets = unique(options.targets.map((target) => target.trim()).filter(Boolean));

  const source: HandoffSource = { project: context.project };
  if (context.repo?.slug) source.repo = context.repo.slug;
  if (context.repo?.branch) source.branch = context.repo.branch;
  if (context.repo?.head?.shortHash) source.commit = context.repo.head.shortHash;
  if (context.revision.spec) source.range = context.revision.spec;

  const frontmatter: HandoffFrontmatter = {
    handoff_version: HANDOFF_VERSION,
    id: options.id?.trim() || buildHandoffId(title, now),
    title,
    created_at: now.toISOString(),
    status: options.status ?? 'ready',
    breaking: options.breaking,
    source,
    targets,
    change_type: unique(options.changeType.map((type) => type.trim()).filter(Boolean)),
  };
  if (options.author) frontmatter.author = options.author;
  if (options.generatedBy) frontmatter.generated_by = options.generatedBy;

  // Emitted in canonical order, and only when the author actually wrote something: an
  // empty optional section is noise, and an empty required one is a validation error the
  // caller should see rather than have papered over.
  const body: Record<string, string | undefined> = { ...options.body };
  const sections: HandoffSection[] = [];
  for (const spec of SECTIONS) {
    const content = body[spec.title]?.trim();
    if (!content) continue;
    sections.push({ title: spec.title, content });
  }

  return { frontmatter, title, bodyTitle: title, h1Count: 1, preamble: '', sections };
}
