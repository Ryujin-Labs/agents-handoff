import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { CONFIG_FILENAME, DEFAULT_DIRECTORY } from '../constants.ts';
import { findUp, readJsonIfExists } from '../util/fs.ts';

/**
 * When a generating agent should stop and ask rather than decide.
 *
 * `when-unclear` is the default because an agent that asks about everything is tedious and
 * one that asks about nothing eventually writes a confident handoff about the wrong half
 * of a mixed working tree.
 */
export type AskPolicy = 'always' | 'when-unclear' | 'never';

export const ASK_POLICIES: readonly AskPolicy[] = ['always', 'when-unclear', 'never'];

export interface ContextConfig {
  /** Cap on how many changed files are described in detail. */
  maxFiles: number;
  /** Cap on how many commits are listed. */
  maxCommits: number;
  /** Collectors to skip, by name. */
  disabledCollectors: string[];
}

export interface HandoffConfig {
  version: number;
  /** Handoff storage directory, relative to the project root. */
  directory: string;
  /** Whether `handoff init` added the storage directory to `.gitignore`. */
  gitignore: boolean;
  /** Logical name of this codebase, written into `source.project`. */
  project: string;
  /** Target used when `handoff create` is run without one. */
  defaultTarget: string | null;
  /**
   * Which consumer *this* repository is, used to narrow an incoming handoff.
   *
   * Deliberately separate from `defaultTarget`: that one says who we usually send to, and
   * the two are opposite ends of the same arrow. A backend whose `defaultTarget` is
   * `mobile` is not mobile, and reusing one for the other makes it claim to be.
   */
  identity: string | null;
  /** Targets offered in prompts and docs. Not a whitelist; anything is accepted. */
  targets: string[];
  /**
   * Language for the prose a generating agent writes, as a plain name ("Turkish") or a
   * BCP 47 tag ("tr"). `null` means English.
   *
   * This exists so a team whose reviewers do not read English can say so once, explicitly,
   * instead of an agent inferring it from whatever language the repository's other
   * documents happen to be in. Section headings stay canonical English either way — they
   * are the machine contract, not prose.
   */
  language: string | null;
  /** How readily a generating agent should check in. */
  ask: AskPolicy;
  includeGitContext: boolean;
  includeTests: boolean;
  context: ContextConfig;
}

export interface LoadedConfig {
  config: HandoffConfig;
  /** Directory containing `handoff.config.json`, or the resolved cwd when there is none. */
  root: string;
  /** Absolute path to the config file, or null when defaults are in use. */
  path: string | null;
  /** False when no config file was found and defaults were substituted. */
  exists: boolean;
  /** Legacy configuration retained on disk but no longer used by the product. */
  ignoredFields: string[];
}

export function defaultConfig(project: string): HandoffConfig {
  return {
    version: 1,
    directory: DEFAULT_DIRECTORY,
    gitignore: false,
    project,
    defaultTarget: null,
    identity: null,
    targets: [],
    language: null,
    ask: 'when-unclear',
    includeGitContext: true,
    includeTests: true,
    context: { maxFiles: 60, maxCommits: 20, disabledCollectors: [] },
  };
}

/**
 * Find and load the project configuration by walking up from `cwd`.
 *
 * A missing config is not an error: every command except `init` works with defaults, so
 * that a receiving developer can run `handoff receive` on a file without setting anything
 * up first.
 */
export function loadConfig(cwd: string): LoadedConfig {
  const start = resolve(cwd);
  const root = findUp(CONFIG_FILENAME, start);
  if (!root) {
    const fallbackRoot = findUp('.git', start) ?? start;
    return {
      config: defaultConfig(basename(fallbackRoot)),
      root: fallbackRoot,
      path: null,
      exists: false,
      ignoredFields: [],
    };
  }
  const path = join(root, CONFIG_FILENAME);
  const raw = readJsonIfExists<Record<string, unknown>>(path) ?? {};
  const ignoredFields = isRecord(raw) ? ['channels', 'routes'].filter((key) => Object.hasOwn(raw, key)) : [];
  return { config: mergeConfig(raw, basename(root)), root, path, exists: true, ignoredFields };
}

// Retain unknown and legacy data outside the active typed configuration. Loading and
// updating a project must not erase fields another version or tool put in its file.
const preservedConfig = new WeakMap<HandoffConfig, Record<string, unknown>>();

export function mergeConfig(input: Partial<HandoffConfig> | Record<string, unknown>, projectFallback: string): HandoffConfig {
  const raw = (isRecord(input) ? input : {}) as Partial<HandoffConfig>;
  const base = defaultConfig(projectFallback);
  const context = (isRecord(raw.context) ? raw.context : {}) as Partial<ContextConfig>;
  const config: HandoffConfig = {
    version: typeof raw.version === 'number' ? raw.version : base.version,
    directory: typeof raw.directory === 'string' && raw.directory ? raw.directory : base.directory,
    gitignore: typeof raw.gitignore === 'boolean' ? raw.gitignore : base.gitignore,
    project: typeof raw.project === 'string' && raw.project ? raw.project : base.project,
    defaultTarget: typeof raw.defaultTarget === 'string' ? raw.defaultTarget : null,
    identity: typeof raw.identity === 'string' && raw.identity.trim() ? raw.identity.trim() : null,
    targets: Array.isArray(raw.targets) ? raw.targets.filter((t) => typeof t === 'string') : base.targets,
    language: typeof raw.language === 'string' && raw.language.trim() ? raw.language.trim() : null,
    ask: ASK_POLICIES.includes(raw.ask as AskPolicy) ? (raw.ask as AskPolicy) : base.ask,
    includeGitContext:
      typeof raw.includeGitContext === 'boolean' ? raw.includeGitContext : base.includeGitContext,
    includeTests: typeof raw.includeTests === 'boolean' ? raw.includeTests : base.includeTests,
    context: {
      maxFiles: positive(context.maxFiles, base.context.maxFiles),
      maxCommits: positive(context.maxCommits, base.context.maxCommits),
      disabledCollectors: Array.isArray(context.disabledCollectors)
        ? context.disabledCollectors.filter((name) => typeof name === 'string')
        : [],
    },
  };
  preservedConfig.set(config, structuredClone(raw) as Record<string, unknown>);
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Absolute path to the handoff storage directory. */
export function handoffDirectory(loaded: LoadedConfig): string {
  const dir = loaded.config.directory;
  return isAbsolute(dir) ? dir : join(loaded.root, dir);
}

export function writeConfig(root: string, config: HandoffConfig): string {
  const path = join(root, CONFIG_FILENAME);
  const previous = readJsonIfExists<Record<string, unknown>>(path);
  const existing = isRecord(previous) ? previous : {};
  const preserved = preservedConfig.get(config) ?? {};
  const output = {
    ...existing,
    ...preserved,
    ...config,
    context: {
      ...(isRecord(existing.context) ? existing.context : {}),
      ...(isRecord(preserved.context) ? preserved.context : {}),
      ...config.context,
    },
  };
  writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  return path;
}

const GITIGNORE_HEADER = '# Agents Handoff (local-only)';

export interface GitignoreResult {
  changed: boolean;
  path: string;
  reason: 'added' | 'already-present' | 'removed' | 'not-present';
}

/**
 * Add the handoff directory to `.gitignore`.
 *
 * Some teams want handoffs committed alongside the change they describe; others want them
 * strictly local. Both are legitimate, so this is a switch rather than a default.
 */
export function ensureGitignored(root: string, directory: string): GitignoreResult {
  const path = join(root, '.gitignore');
  const entry = `${directory.replace(/\/+$/, '')}/`;
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = existing.split('\n').map((line) => line.trim());
  if (lines.includes(entry) || lines.includes(entry.replace(/\/$/, ''))) {
    return { changed: false, path, reason: 'already-present' };
  }
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(path, `${existing}${prefix}\n${GITIGNORE_HEADER}\n${entry}\n`, 'utf8');
  return { changed: true, path, reason: 'added' };
}

/** Remove the entry added by {@link ensureGitignored}. Used when flipping the switch off. */
export function removeFromGitignore(root: string, directory: string): GitignoreResult {
  const path = join(root, '.gitignore');
  if (!existsSync(path)) return { changed: false, path, reason: 'not-present' };
  const entry = `${directory.replace(/\/+$/, '')}/`;
  const lines = readFileSync(path, 'utf8').split('\n');
  const kept = lines.filter(
    (line) => line.trim() !== entry && line.trim() !== entry.replace(/\/$/, '') && line.trim() !== GITIGNORE_HEADER,
  );
  if (kept.length === lines.length) return { changed: false, path, reason: 'not-present' };
  writeFileSync(path, kept.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
  return { changed: true, path, reason: 'removed' };
}
