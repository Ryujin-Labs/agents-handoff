import type { ChangeType, Status } from './constants.ts';

export interface HandoffSource {
  project: string;
  repo?: string;
  branch?: string;
  commit?: string;
  range?: string;
  /** Unknown keys, preserved verbatim so a round trip never loses information. */
  extra?: Record<string, unknown>;
}

export interface HandoffLink {
  label: string;
  url: string;
}

/** The parsed YAML frontmatter of a handoff. See SPEC.md section 1. */
export interface HandoffFrontmatter {
  handoff_version: number;
  id: string;
  title?: string;
  created_at: string;
  status: Status;
  breaking: boolean;
  source: HandoffSource;
  targets: string[];
  change_type: ChangeType[];
  author?: string;
  generated_by?: string;
  supersedes?: string;
  expires_at?: string;
  links?: HandoffLink[];
  /** Unknown keys, preserved verbatim so a round trip never loses information. */
  extra?: Record<string, unknown>;
  /**
   * The required keys the parser normalizes (`breaking`, `targets`, `change_type`), exactly
   * as the document wrote them, and only for the keys it actually wrote.
   *
   * Normalizing erases the difference between "absent" and "written wrong": `breaking: yes`
   * is the string "yes" under YAML 1.2, and both it and a missing key collapse to `false`.
   * That difference is the one thing the validator must not guess at, so the uncoerced value
   * is kept here — the same way {@link extra} keeps unknown keys — and the serializer writes
   * it back rather than inventing a value nobody chose.
   *
   * Set by {@link parseHandoff}. A handoff built in memory has no source text to record, and
   * its typed fields are the truth.
   */
  declared?: Record<string, unknown>;
}

export interface HandoffSection {
  /** Heading text exactly as written. */
  title: string;
  /** Body of the section, with surrounding blank lines trimmed. */
  content: string;
}

/** A parsed handoff document. */
export interface Handoff {
  frontmatter: HandoffFrontmatter;
  /** Effective title: the frontmatter `title` when set, otherwise the body H1. */
  title: string;
  /** The body's own H1 text, independent of frontmatter. */
  bodyTitle: string | null;
  /** How many H1 headings the body contains. The spec requires exactly one. */
  h1Count: number;
  /** `##` sections in document order. */
  sections: HandoffSection[];
  /** Any content between the H1 and the first `##`, if present. */
  preamble: string;
  /** The original source text, when the handoff came from a file or string. */
  raw?: string;
}

export type IssueSeverity = 'error' | 'warning';

export interface Issue {
  severity: IssueSeverity;
  /** Stable machine code, e.g. `missing-section`. */
  code: string;
  message: string;
  /** Dotted path into the frontmatter, or a section title, when applicable. */
  path?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}
