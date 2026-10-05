/** The only handoff format version this implementation speaks. */
export const HANDOFF_VERSION = 1;

/** File name used for the canonical handoff document inside a handoff directory. */
export const HANDOFF_FILENAME = 'HANDOFF.md';

/** Default directory, relative to the project root, where handoffs are stored. */
export const DEFAULT_DIRECTORY = '.handoff';

/** Sub-directory of the handoff directory holding handoffs received from other people. */
export const INBOX_DIRNAME = 'inbox';

/** Name of the project configuration file. */
export const CONFIG_FILENAME = 'handoff.config.json';

export const STATUSES = ['draft', 'ready', 'delivered', 'acknowledged', 'complete'] as const;
export type Status = (typeof STATUSES)[number];

/**
 * Known `change_type` values. This is an *open* vocabulary: unknown values are warned
 * about, never rejected. See SPEC.md section 1.3.
 */
export const KNOWN_CHANGE_TYPES = [
  'api',
  'authentication',
  'authorization',
  'contract',
  'schema',
  'database',
  'migration',
  'config',
  'environment',
  'dependency',
  'infrastructure',
  'performance',
  'security',
  'behavior',
  'ui',
  'deprecation',
  'removal',
  'bugfix',
  'feature',
  'refactor',
  'tooling',
] as const;
export type ChangeType = (typeof KNOWN_CHANGE_TYPES)[number] | (string & {});

export interface SectionSpec {
  /** Canonical heading text. */
  readonly title: string;
  /** Always required, required only when `breaking: true`, or optional. */
  readonly requirement: 'required' | 'required-if-breaking' | 'optional';
  /** One-line description, surfaced in templates and docs. */
  readonly purpose: string;
}

/**
 * The canonical section list, in canonical order. Order is not enforced by the validator
 * but is used whenever we generate a document.
 */
export const SECTIONS: readonly SectionSpec[] = [
  {
    title: 'Summary',
    requirement: 'required',
    purpose: "1-4 sentences. What changed, in the consumer's vocabulary.",
  },
  {
    title: 'Why This Matters',
    requirement: 'required',
    purpose: 'The consequence of ignoring this. Not the engineering rationale.',
  },
  {
    title: 'Changes',
    requirement: 'required',
    purpose: 'The concrete behavioral delta. Prefer previous -> new.',
  },
  {
    title: 'Required Actions',
    requirement: 'required',
    purpose: 'The most important section. Imperative, numbered, per target.',
  },
  {
    title: 'Breaking Changes',
    requirement: 'required-if-breaking',
    purpose: 'What breaks for a consumer that does nothing.',
  },
  {
    title: 'Contracts',
    requirement: 'optional',
    purpose: 'Endpoints, payloads, types, events. The literal interface.',
  },
  {
    title: 'Relevant Source',
    requirement: 'optional',
    purpose: 'A short list of paths in the source repository.',
  },
  {
    title: 'Verification',
    requirement: 'required',
    purpose: 'How the receiver proves their implementation is correct.',
  },
  {
    title: 'Instructions for Receiving Agent',
    requirement: 'required',
    purpose: 'Second most important. How the receiving agent should approach its own codebase.',
  },
  {
    title: 'Out of Scope',
    requirement: 'optional',
    purpose: 'What deliberately did not change. Prevents over-implementation.',
  },
  { title: 'Notes', requirement: 'optional', purpose: 'Anything else.' },
];

export const REQUIRED_SECTIONS = SECTIONS.filter((s) => s.requirement === 'required').map(
  (s) => s.title,
);

/** Content-quality thresholds. Every one of these produces a warning, never an error. */
export const LIMITS = {
  /** A handoff longer than this stopped being a handoff and became documentation. */
  maxWords: 1200,
  /** Handoffs carry contracts, not diffs. */
  maxCodeBlockLines: 60,
  /** `id` length cap. */
  maxIdLength: 120,
} as const;

export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
