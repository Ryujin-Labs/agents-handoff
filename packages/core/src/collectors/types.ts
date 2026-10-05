import type { HandoffConfig } from '../config/index.ts';
import type { ChangedFile, Git, Revision } from '../git/index.ts';
import type { Classification } from './classify.ts';

/** Kinds of signal a collector can raise. Maps loosely onto `change_type`. */
export type SignalKind =
  | 'api'
  | 'auth'
  | 'contract'
  | 'database'
  | 'environment'
  | 'dependency'
  | 'infrastructure'
  | 'config'
  | 'test'
  | 'breaking-candidate';

/**
 * A single observation about the change.
 *
 * A signal is evidence, never a conclusion. `breaking-candidate` in particular means "a
 * human or an agent should look at this", not "this is a breaking change" — the collectors
 * cannot tell the difference and must not pretend to.
 */
export interface Signal {
  kind: SignalKind;
  /** One line, written to be read directly in the brief. */
  message: string;
  /** File that produced the signal, when there is exactly one. */
  file?: string;
  /** Verbatim source line the signal came from, trimmed. */
  evidence?: string;
}

export interface CollectorResult {
  name: string;
  /** One-line headline, or null when the collector found nothing worth saying. */
  summary: string | null;
  signals: Signal[];
  /** Files this collector thinks are worth opening, most interesting first. */
  suggestedReading: string[];
  /** Extra key/value facts rendered as a small list under the collector's heading. */
  facts: Array<{ label: string; value: string }>;
}

export interface CollectorContext {
  cwd: string;
  /** Project root: where `handoff.config.json` lives, or the git root. */
  root: string;
  config: HandoffConfig;
  git: Git;
  revision: Revision;
  changedFiles: ChangedFile[];
  classification: Classification;
  /** Lazily-parsed diff for a set of paths, cached per call site. */
  diffFor(paths: string[]): import('./diff.ts').FileDiff[];
}

export interface Collector {
  name: string;
  /** Shown by `handoff config --collectors`. */
  description: string;
  collect(context: CollectorContext): CollectorResult;
}

export function emptyResult(name: string): CollectorResult {
  return { name, summary: null, signals: [], suggestedReading: [], facts: [] };
}
