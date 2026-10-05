import {
  HANDOFF_VERSION,
  ID_PATTERN,
  KNOWN_CHANGE_TYPES,
  LIMITS,
  SECTIONS,
  STATUSES,
} from '../constants.ts';
import { type CoercedKey, isWellFormed } from '../markdown/declared.ts';
import { extractCodeBlocks, findSection, hasContent } from '../markdown/sections.ts';
import { HandoffParseError, parseHandoff } from '../markdown/parse.ts';
import type { Handoff, HandoffFrontmatter, Issue, ValidationResult } from '../types.ts';
import { countWords, normalizeHeading } from '../util/text.ts';

const KNOWN_TYPES = new Set<string>(KNOWN_CHANGE_TYPES);
const KNOWN_SECTION_TITLES = new Set(SECTIONS.map((section) => normalizeHeading(section.title)));

function error(code: string, message: string, path?: string): Issue {
  return path === undefined
    ? { severity: 'error', code, message }
    : { severity: 'error', code, message, path };
}

function warn(code: string, message: string, path?: string): Issue {
  return path === undefined
    ? { severity: 'warning', code, message }
    : { severity: 'warning', code, message, path };
}

/** Parse and validate a handoff document in one step. */
export function validateHandoffSource(source: string): ValidationResult & { handoff?: Handoff } {
  let handoff: Handoff;
  try {
    handoff = parseHandoff(source);
  } catch (err) {
    const message = err instanceof HandoffParseError ? err.message : String(err);
    return { ok: false, errors: [error('parse-failed', message)], warnings: [] };
  }
  return { ...validateHandoff(handoff), handoff };
}

/**
 * Validate a parsed handoff against the v1 specification.
 *
 * Errors mean "this is not a conforming handoff". Warnings mean "this is a conforming
 * handoff that will serve its reader badly". The distinction matters: a warning must never
 * stop a document from being written or read.
 */
export function validateHandoff(handoff: Handoff): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const fm = handoff.frontmatter;

  // --- frontmatter -----------------------------------------------------------------
  if (!Number.isInteger(fm.handoff_version)) {
    errors.push(error('missing-version', '`handoff_version` is required', 'handoff_version'));
  } else if (fm.handoff_version !== HANDOFF_VERSION) {
    errors.push(
      error(
        'unsupported-version',
        `handoff_version ${fm.handoff_version} is not supported (this implementation speaks version ${HANDOFF_VERSION})`,
        'handoff_version',
      ),
    );
  }

  if (!fm.id) {
    errors.push(error('missing-id', '`id` is required', 'id'));
  } else if (!ID_PATTERN.test(fm.id)) {
    errors.push(
      error(
        'invalid-id',
        `id "${fm.id}" must match ${ID_PATTERN.source} (lowercase, no spaces)`,
        'id',
      ),
    );
  } else if (fm.id.length > LIMITS.maxIdLength) {
    errors.push(error('invalid-id', `id must be at most ${LIMITS.maxIdLength} characters`, 'id'));
  }

  if (!fm.created_at) {
    errors.push(error('missing-created-at', '`created_at` is required', 'created_at'));
  } else if (!isIsoTimestamp(fm.created_at)) {
    errors.push(
      error('invalid-created-at', '`created_at` must be an ISO 8601 timestamp', 'created_at'),
    );
  }

  if (fm.expires_at && !isIsoTimestamp(fm.expires_at)) {
    errors.push(
      error('invalid-expires-at', '`expires_at` must be an ISO 8601 timestamp', 'expires_at'),
    );
  }

  if (!fm.status) {
    errors.push(error('missing-status', '`status` is required', 'status'));
  } else if (!(STATUSES as readonly string[]).includes(fm.status)) {
    errors.push(
      error('invalid-status', `status must be one of: ${STATUSES.join(', ')}`, 'status'),
    );
  }

  if (!fm.source.project) {
    errors.push(error('missing-source-project', '`source.project` is required', 'source.project'));
  }

  // `breaking`, `targets` and `change_type` are required by SPEC.md 1.1, and all three
  // arrive here already normalized — which means an absent key and a key written wrong are
  // indistinguishable from the parsed value alone. `declared` keeps them apart, and this is
  // the one place that difference is reported.
  //
  // These are errors, not warnings, and `breaking` is why. A rejected document is a lost
  // document, so the bar for an error is high: it has to be worse to accept the file than to
  // refuse it. `breaking: yes` clears that bar. YAML 1.2 reads it as the string "yes", the
  // parser reads anything that is not `true` as `false`, and from there the document is
  // quietly missing the one claim it exists to make — "Breaking Changes" stops being a
  // required section, and a receiver is never told that doing nothing will break them.
  // Coercing it would mean guessing at the single decision the writer was asked to make.
  requireDeclared(errors, fm, 'breaking', '`breaking` is required: state `true` or `false`');
  requireDeclared(
    errors,
    fm,
    'targets',
    '`targets` is required: name the consumers who must act, or `[]` for any consumer',
  );
  requireDeclared(
    errors,
    fm,
    'change_type',
    '`change_type` is required: say what kind of change this is, or `[]` to classify none',
  );

  if (fm.change_type.length === 0) {
    warnings.push(
      warn('empty-change-type', '`change_type` is empty; receivers use it to triage', 'change_type'),
    );
  }
  for (const type of fm.change_type) {
    if (!KNOWN_TYPES.has(type)) {
      warnings.push(
        warn('unknown-change-type', `change_type "${type}" is outside the known vocabulary`, 'change_type'),
      );
    }
  }

  if (fm.targets.length === 0) {
    warnings.push(
      warn(
        'no-targets',
        '`targets` is empty, so this handoff addresses any consumer. Naming a target produces sharper Required Actions.',
        'targets',
      ),
    );
  }

  for (const [key] of Object.entries(fm.extra ?? {})) {
    if (key.startsWith('x-')) continue;
    warnings.push(warn('unknown-field', `unknown frontmatter key "${key}" was preserved`, key));
  }

  // --- body ------------------------------------------------------------------------
  if (handoff.h1Count === 0) {
    errors.push(
      error(
        'missing-title',
        'the body must start with a single `#` title. A frontmatter `title` is not a substitute: the H1 is what a reader sees when the document is pasted somewhere that hides frontmatter.',
      ),
    );
  } else if (handoff.h1Count > 1) {
    errors.push(
      error('multiple-titles', `the body has ${handoff.h1Count} \`#\` headings; a handoff describes one change and has one title`),
    );
  }
  if (handoff.frontmatter.title && handoff.bodyTitle && handoff.frontmatter.title !== handoff.bodyTitle) {
    warnings.push(
      warn('title-mismatch', 'the frontmatter `title` and the body `#` heading differ', 'title'),
    );
  }

  for (const spec of SECTIONS) {
    const required =
      spec.requirement === 'required' ||
      (spec.requirement === 'required-if-breaking' && fm.breaking);
    if (!required) continue;
    if (!hasContent(handoff.sections, spec.title)) {
      const reason =
        spec.requirement === 'required-if-breaking'
          ? ' (required because `breaking: true`)'
          : '';
      errors.push(
        error(
          'missing-section',
          `section "## ${spec.title}" is missing or empty${reason}`,
          spec.title,
        ),
      );
    }
  }

  // A draft is explicitly incomplete: the scaffold lists breaking *candidates* there for
  // the writer to confirm, and `breaking` is not decided until the document is finished.
  if (fm.status !== 'draft' && !fm.breaking && hasContent(handoff.sections, 'Breaking Changes')) {
    warnings.push(
      warn(
        'breaking-mismatch',
        '`breaking: false` but a non-empty "Breaking Changes" section is present',
        'breaking',
      ),
    );
  }

  for (const section of handoff.sections) {
    if (!KNOWN_SECTION_TITLES.has(normalizeHeading(section.title))) {
      warnings.push(
        warn('unknown-section', `Section "${section.title}" is not a standard section`, section.title),
      );
    }
  }

  for (const issue of checkQuality(handoff)) {
    // A scaffold is a draft by construction. A document that calls itself ready while
    // still carrying TODO markers is a contradiction, and delivering it is how a teammate
    // ends up with a template instead of a handoff.
    if (issue.code === 'unfilled-template' && fm.status !== 'draft') {
      errors.push({ ...issue, severity: 'error' });
    } else {
      warnings.push(issue);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Report a required key that the parser had to normalize: absent, or present in a shape the
 * spec does not allow. Never coerced into a verdict — see the note at the call sites.
 *
 * A handoff with no `declared` map was built in memory rather than read from a document, so
 * its typed fields are the only thing that was ever written and there is nothing to compare.
 */
function requireDeclared(
  errors: Issue[],
  fm: HandoffFrontmatter,
  key: CoercedKey,
  missing: string,
): void {
  const declared = fm.declared;
  if (declared === undefined) return;

  const code = key.replace(/_/g, '-');
  if (!Object.hasOwn(declared, key)) {
    errors.push(error(`missing-${code}`, missing, key));
    return;
  }

  const value = declared[key];
  if (isWellFormed(key, value)) return;

  const detail =
    key === 'breaking'
      ? `\`breaking\` must be a YAML boolean, not ${describeYaml(value)}. YAML 1.2 reads \`yes\`, \`"true"\` and \`1\` as a string or a number, so none of them says what \`true\` says — write \`true\` or \`false\`.`
      : `\`${key}\` must be a list of strings (or a single string), not ${describeYaml(value)}`;
  errors.push(error(`invalid-${code}`, detail, key));
}

/** The offending value, short enough to sit in a message and close to how it was written. */
function describeYaml(value: unknown): string {
  if (value === null || value === undefined) return 'an empty value';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return Array.isArray(value) ? 'a list of non-scalar values' : 'a mapping';
}

/** Marker written by the scaffolder wherever a decision is still owed. */
const TODO_MARKER = /<!--\s*TODO\s*-->/i;

/**
 * The body as a reader sees it, for a handoff that was built in memory and never had
 * source text: composed and scaffolded documents. Without this every length and code
 * block rule silently passed for exactly the documents agents produce.
 */
function bodyText(handoff: Handoff): string {
  return [
    `# ${handoff.bodyTitle ?? handoff.title}`,
    handoff.preamble,
    ...handoff.sections.map((section) => `## ${section.title}\n\n${section.content}`),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Rules from SPEC.md section 2.4. Warnings by design, with one exception applied by the
 * caller: an unfilled scaffold that is not marked `draft` is an error.
 */
function checkQuality(handoff: Handoff): Issue[] {
  const issues: Issue[] = [];
  const source = handoff.raw ?? bodyText(handoff);

  const unfilled = handoff.sections.filter((section) => TODO_MARKER.test(section.content));
  if (unfilled.length > 0) {
    issues.push(
      warn(
        'unfilled-template',
        `${unfilled.length} section(s) still contain a TODO marker: ${unfilled.map((s) => s.title).join(', ')}. This handoff is a scaffold, not a handoff.`,
      ),
    );
  }

  const words = countWords(source.replace(/^---[\s\S]*?^---/m, ''));
  if (words > LIMITS.maxWords) {
    issues.push(
      warn(
        'too-long',
        `handoff is ~${words} words (soft limit ${LIMITS.maxWords}). Cut background, keep decisions.`,
      ),
    );
  }

  for (const block of extractCodeBlocks(source)) {
    if (block.lineCount > LIMITS.maxCodeBlockLines) {
      issues.push(
        warn(
          'oversized-code-block',
          `a ${block.lineCount}-line code block exceeds ${LIMITS.maxCodeBlockLines} lines. Handoffs carry contracts, not implementations.`,
        ),
      );
    }
    if (/^(?:diff --git |@@ -\d)/m.test(block.content)) {
      issues.push(
        warn(
          'diff-dump',
          'a code block contains a raw diff. Describe the behavioral change and cite file paths instead.',
        ),
      );
    }
  }

  const actions = findSection(handoff.sections, 'Required Actions');
  if (actions && actions.content.trim()) {
    const hasList = /^\s*(?:\d+[.)]|[-*+])\s+\S/m.test(actions.content);
    if (!hasList) {
      issues.push(
        warn(
          'unstructured-actions',
          '"Required Actions" has no list items. A receiving agent works best from a numbered list of imperatives.',
          'Required Actions',
        ),
      );
    }
    const lower = actions.content.toLowerCase();
    for (const target of handoff.frontmatter.targets) {
      if (handoff.frontmatter.targets.length > 1 && !lower.includes(target.toLowerCase())) {
        issues.push(
          warn(
            'target-not-addressed',
            `target "${target}" is not mentioned in "Required Actions"`,
            'Required Actions',
          ),
        );
      }
    }
  }

  return issues;
}

/** ISO 8601 with a date and, when a time is present, an explicit offset. */
export function isIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))?$/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

/** Render a validation result as human-readable lines. */
export function formatIssues(result: ValidationResult): string[] {
  return [...result.errors, ...result.warnings].map((issue) => {
    const label = issue.severity === 'error' ? 'error' : 'warn';
    const where = issue.path ? ` [${issue.path}]` : '';
    return `${label}${where}: ${issue.message} (${issue.code})`;
  });
}
