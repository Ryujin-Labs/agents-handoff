import { HANDOFF_VERSION, SECTIONS } from '../constants.ts';
import { breakingCandidates, inferChangeTypes, type ChangeContext } from '../context/collect.ts';
import type { Handoff, HandoffFrontmatter, HandoffSection, HandoffSource } from '../types.ts';
import { buildHandoffId, slugify } from '../util/slug.ts';
import { truncate, unique } from '../util/text.ts';

export interface ScaffoldOptions {
  context: ChangeContext;
  /** Handoff title. Defaults to the head commit subject. */
  title?: string | undefined;
  /** Explicit id. Defaults to `YYYY-MM-DD-<slug of title>`. */
  id?: string | undefined;
  targets?: string[];
  author?: string | undefined;
  generatedBy?: string | undefined;
  now?: Date;
  /**
   * Fill sections with guidance prompts rather than leaving them empty. On by default:
   * the scaffold exists to be completed, and an empty heading tells the writer nothing.
   */
  withPrompts?: boolean;
}

const PLACEHOLDER = '<!-- TODO -->';

/**
 * Build a draft handoff from collected context, with no model involved.
 *
 * Everything here is either a fact from git or an instruction to the writer. It is
 * deliberately never a guess dressed up as prose: a scaffold that invents a Summary would
 * be worse than one that asks for it, because a plausible wrong summary gets shipped.
 */
export function scaffoldHandoff(options: ScaffoldOptions): Handoff {
  const { context } = options;
  const now = options.now ?? new Date();
  const title = options.title ?? deriveTitle(context);
  const targets = unique(options.targets ?? context.targets);

  const source: HandoffSource = { project: context.project };
  if (context.repo?.slug) source.repo = context.repo.slug;
  if (context.repo?.branch) source.branch = context.repo.branch;
  if (context.repo?.head?.shortHash) source.commit = context.repo.head.shortHash;
  if (context.revision.spec) source.range = context.revision.spec;

  const frontmatter: HandoffFrontmatter = {
    handoff_version: HANDOFF_VERSION,
    id: options.id ?? buildHandoffId(title, now),
    title,
    created_at: now.toISOString(),
    status: 'draft',
    // A scaffold must never assert a breaking change it cannot verify. The writer decides.
    breaking: false,
    source,
    targets,
    change_type: inferChangeTypes(context),
  };
  if (options.author) frontmatter.author = options.author;
  if (options.generatedBy) frontmatter.generated_by = options.generatedBy;

  return {
    frontmatter,
    title,
    bodyTitle: title,
    h1Count: 1,
    preamble: '',
    sections: buildSections(context, targets, options.withPrompts !== false),
  };
}

function buildSections(
  context: ChangeContext,
  targets: string[],
  withPrompts: boolean,
): HandoffSection[] {
  const sections: HandoffSection[] = [];

  for (const spec of SECTIONS) {
    if (spec.requirement === 'optional' && !hasMaterialFor(spec.title, context)) continue;

    let content = withPrompts ? `${PLACEHOLDER} ${spec.purpose}` : PLACEHOLDER;

    if (spec.title === 'Required Actions' && targets.length > 1) {
      content = targets
        .map((target) => `### ${target}\n\n1. ${PLACEHOLDER} What must ${target} change?`)
        .join('\n\n');
    } else if (spec.title === 'Required Actions') {
      const target = targets[0];
      content = `1. ${PLACEHOLDER} What must ${target ?? 'the receiver'} change?`;
    } else if (spec.title === 'Breaking Changes') {
      const candidates = breakingCandidates(context);
      content = candidates.length
        ? [
            `${PLACEHOLDER} Confirm or delete each line below; these are pattern matches, not findings.`,
            '',
            ...candidates.slice(0, 10).map((signal) => `- ${signal.message}${signal.file ? ` (${signal.file})` : ''}`),
          ].join('\n')
        : `${PLACEHOLDER} ${spec.purpose}`;
    } else if (spec.title === 'Relevant Source') {
      const paths = suggestedPaths(context);
      if (paths.length > 0) content = paths.map((path) => `- \`${path}\``).join('\n');
    } else if (spec.title === 'Verification') {
      const command = testCommand(context);
      content = command
        ? `Source repository: \`${command}\` passes.\n\n${PLACEHOLDER} What should the receiver run or click to prove their side works?`
        : `${PLACEHOLDER} ${spec.purpose}`;
    } else if (spec.title === 'Instructions for Receiving Agent') {
      content = [
        `${PLACEHOLDER} Tell the receiving agent how to approach its own codebase.`,
        '',
        'Useful things to say here: which existing module to modify rather than duplicate,',
        'what not to build, and what to report back if the contract does not match.',
      ].join('\n');
    }

    sections.push({ title: spec.title, content });
  }

  return sections;
}

/** Only include an optional section when the context actually produced material for it. */
function hasMaterialFor(title: string, context: ChangeContext): boolean {
  if (title === 'Relevant Source') return suggestedPaths(context).length > 0;
  return false;
}

function suggestedPaths(context: ChangeContext): string[] {
  const suggested = unique(context.results.flatMap((result) => result.suggestedReading));
  if (suggested.length > 0) return suggested.slice(0, 8);
  return context.changedFiles.slice(0, 6).map((file) => file.path);
}

function testCommand(context: ChangeContext): string | null {
  for (const result of context.results) {
    const fact = result.facts.find((entry) => entry.label === 'test command');
    if (fact) return fact.value;
  }
  return null;
}

/**
 * Best available title, in descending order of usefulness: the developer's note, the
 * branch name, the head commit subject.
 */
function deriveTitle(context: ChangeContext): string {
  if (context.note) return truncate(capitalize(context.note), 70);
  const branch = context.repo?.branch;
  if (branch && !/^(main|master|develop|trunk)$/.test(branch)) {
    const cleaned = branch.replace(/^(feature|feat|fix|chore|bugfix|hotfix)\//, '').replace(/[-_]/g, ' ');
    if (cleaned.trim()) return capitalize(cleaned.trim());
  }
  const subject = context.repo?.head?.subject;
  if (subject) return truncate(capitalize(subject.replace(/^\w+(\([^)]*\))?!?:\s*/, '')), 70);
  return 'Untitled change';
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Suggest an id from a title without building a whole scaffold. */
export function suggestId(title: string, now: Date): string {
  return `${buildHandoffId(slugify(title), now).slice(0, 10)}-${slugify(title)}`;
}
