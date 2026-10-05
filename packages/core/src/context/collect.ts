import { resolve } from 'node:path';
import { collectorsFor } from '../collectors/index.ts';
import { classifyAll, isNoise } from '../collectors/classify.ts';
import { parseUnifiedDiff, type FileDiff } from '../collectors/diff.ts';
import type { CollectorContext, CollectorResult, Signal } from '../collectors/types.ts';
import { handoffDirectory, type LoadedConfig } from '../config/index.ts';
import { CONFIG_FILENAME } from '../constants.ts';
import { routesFor } from '../config/channels.ts';
import { Git, type ChangedFile, type RepoInfo, type Revision } from '../git/index.ts';
import { HandoffStore } from '../storage/index.ts';
import { resolveRevision, type RevisionRequest } from './revision.ts';

export interface ChangeContext {
  /** Absolute project root. */
  root: string;
  project: string;
  repo: RepoInfo | null;
  revision: Revision;
  changedFiles: ChangedFile[];
  /** Files excluded from analysis as build output or vendored code. */
  ignoredFiles: string[];
  results: CollectorResult[];
  /** Targets this brief was collected for. */
  targets: string[];
  /** Free-form instruction from the developer, e.g. "tell mobile about the auth change". */
  note: string | null;
  /** Configured prose language, or null for the English default. */
  language: string | null;
  /** How readily the generating agent should check in. */
  ask: import('../config/index.ts').AskPolicy;
  /** Channels configured to reach the targets of this handoff. */
  routes: string[];
  /** Non-fatal problems, e.g. "not a git repository". */
  warnings: string[];
  /**
   * Handoffs this project already wrote at this commit, or recently from this branch. One
   * may describe the same change; whether to update it or write another is the developer's
   * call, since it may already have been sent.
   */
  existing: ExistingHandoff[];
  generatedAt: string;
}

export interface ExistingHandoff {
  id: string;
  title: string;
  createdAt: string;
  targets: string[];
  status: string;
}

export interface CollectOptions extends RevisionRequest {
  cwd: string;
  loaded: LoadedConfig;
  targets?: string[];
  note?: string | null | undefined;
  now?: Date;
}

/**
 * Assemble everything deterministic we know about a change.
 *
 * The output of this function is the only input a generating agent needs beyond its own
 * memory of the work. Keeping it a plain data structure with no model calls is what makes
 * the pipeline testable, fast, and portable to agents other than Claude Code.
 */
export function collectChangeContext(options: CollectOptions): ChangeContext {
  const { loaded } = options;
  const root = loaded.root;
  const git = new Git(root);
  const warnings: string[] = [];
  const generatedAt = (options.now ?? new Date()).toISOString();

  if (!git.isRepo()) {
    return {
      root,
      project: loaded.config.project,
      repo: null,
      revision: { spec: '', description: 'not a git repository', includesWorkingTree: false },
      changedFiles: [],
      ignoredFiles: [],
      results: [],
      targets: options.targets ?? [],
      note: options.note ?? null,
      language: loaded.config.language,
      ask: loaded.config.ask,
      routes: routesFor(loaded.config.routes, loaded.config.channels, options.targets ?? []),
      warnings: ['Not a git repository, so no change context could be collected.'],
      existing: [],
      generatedAt,
    };
  }

  if (!git.hasCommits()) warnings.push('Repository has no commits yet.');

  const skip = skipMatcher(loaded, git);
  const revision = resolveRevision(git, { ...options, ignore: skip });
  const allFiles = git.changedFiles(revision);
  const changedFiles = allFiles.filter((file) => !skip(file.path));
  const ignoredFiles = allFiles.filter((file) => skip(file.path)).map((file) => file.path);

  if (options.working && (options.base || options.commits || options.since)) {
    warnings.push(
      'The working tree was described, and the base, commits or since that came with it were ignored: they select committed history, and the working tree is what is not committed yet.',
    );
  }

  // Say so loudly: an empty file list from a failed diff is indistinguishable from a
  // clean tree, and silently reporting "no changes" would be a wrong answer, not a
  // missing one.
  const reportedFailures = reportGitFailures(git, warnings, 0);
  if (reportedFailures === 0 && changedFiles.length === 0) {
    const shown = ignoredFiles.slice(0, 5).join(', ');
    warnings.push(
      ignoredFiles.length > 0
        ? `Only build output, lockfiles or this tool's own files changed in ${revision.spec || 'the working tree'} (${ignoredFiles.length}: ${shown}${ignoredFiles.length > 5 ? ', …' : ''}), so there is nothing here to hand off. Select a different revision if you meant another change.`
        : `No changes found for ${revision.spec || 'the working tree'} (${revision.description}). Select a different revision: another base, a number of recent commits, or a since date.`,
    );
  }

  // A branch revision describes commits. Work sitting uncommitted beside it — often the
  // migration or the config change that belongs to the same feature — is outside it, and
  // leaving it out without a word is how a destructive change misses its handoff.
  if (!revision.includesWorkingTree) {
    // Scope paths are relative to where git runs; status paths to the repository root.
    const scope = (options.paths ?? [])
      .map((prefix) => git.relativeToRoot(resolve(root, prefix)) ?? '')
      .filter((prefix) => prefix !== '');
    const pending = git
      .uncommittedPaths()
      .filter((path) => !skip(path))
      .filter((path) => scope.length === 0 || scope.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)));
    if (pending.length > 0) {
      const shown = pending.slice(0, 5).join(', ');
      warnings.push(
        `${pending.length} uncommitted file(s) are not part of this revision: ${shown}${pending.length > 5 ? ', …' : ''}. ` +
          'If they belong to this change, commit them first, or describe the working tree instead (--working in the CLI, working: true in the MCP tools).',
      );
    }
  }

  const limit = loaded.config.context.maxFiles;
  if (changedFiles.length > limit) {
    warnings.push(
      `${changedFiles.length} files changed, above the configured limit of ${limit}. Only the ${limit} largest are analyzed in detail.`,
    );
  }

  const considered = [...changedFiles]
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, limit);

  const classification = classifyAll(considered.map((file) => file.path));
  const diffCache = new Map<string, FileDiff[]>();

  const collectorContext: CollectorContext = {
    cwd: options.cwd,
    root,
    config: loaded.config,
    git,
    revision,
    changedFiles: considered,
    classification,
    diffFor(paths: string[]): FileDiff[] {
      if (paths.length === 0) return [];
      const key = paths.join(' ');
      const cached = diffCache.get(key);
      if (cached) return cached;
      const parsed = parseUnifiedDiff(git.diff(revision, paths, 0));
      diffCache.set(key, parsed);
      return parsed;
    },
  };

  const results = loaded.config.includeGitContext
    ? collectorsFor(loaded.config.context.disabledCollectors)
        .map((collector) => collector.collect(collectorContext))
        .filter(
          (result) =>
            result.summary !== null || result.signals.length > 0 || result.facts.length > 0,
        )
    : [];

  // Read the failure list a second time. The collectors run after the check above and make
  // their own git calls through `diffFor`, so a diff that fails there — maxBuffer on a huge
  // change, a real timeout — would otherwise produce zero signals and an empty Warnings
  // section. The guard has to be structural, not a matter of which call happened first.
  reportGitFailures(git, warnings, reportedFailures);

  const repo = git.info();
  return {
    root,
    project: loaded.config.project,
    repo,
    revision,
    changedFiles: considered,
    ignoredFiles,
    results,
    targets: options.targets ?? [],
    note: options.note ?? null,
    language: loaded.config.language,
    ask: loaded.config.ask,
    routes: routesFor(loaded.config.routes, loaded.config.channels, options.targets ?? []),
    warnings,
    existing: existingHandoffs(loaded, repo, options.now ?? new Date()),
    generatedAt,
  };
}

const RECENT_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Handoffs written at this commit, or in the last two weeks from this branch, newest first.
 *
 * Computed, not judged: whether one of them describes the change at hand is for the agent
 * to read, and whether to replace it is for the developer to say.
 */
function existingHandoffs(loaded: LoadedConfig, repo: RepoInfo | null, now: Date): ExistingHandoff[] {
  if (!repo) return [];
  let stored;
  try {
    stored = new HandoffStore(handoffDirectory(loaded)).list('outgoing').handoffs;
  } catch {
    return [];
  }
  const head = repo.head?.shortHash ?? null;
  const since = now.getTime() - RECENT_MS;
  return stored
    .filter(({ handoff }) => {
      const source = handoff.frontmatter.source;
      if (head && source?.commit && (source.commit.startsWith(head) || head.startsWith(source.commit))) return true;
      return Boolean(repo.branch) && source?.branch === repo.branch && Date.parse(handoff.frontmatter.created_at) >= since;
    })
    .sort((a, b) => Date.parse(b.handoff.frontmatter.created_at) - Date.parse(a.handoff.frontmatter.created_at))
    .slice(0, 5)
    .map(({ id, handoff }) => ({
      id,
      title: handoff.title,
      createdAt: handoff.frontmatter.created_at,
      targets: handoff.frontmatter.targets,
      status: handoff.frontmatter.status,
    }));
}

/**
 * Paths that are this tool's own files rather than part of the change: stored handoffs
 * and the project configuration. Analysing them made the prose of the last handoff show
 * up as API and auth signals in the next one.
 */
/**
 * Paths that are never part of a change: build output and vendored code, and this tool's
 * own files. The same test decides what a brief analyses and what makes a working tree
 * count as dirty, so the two can never disagree.
 */
export function skipMatcher(loaded: LoadedConfig, git: Git): (path: string) => boolean {
  const own = ownOutputMatcher(loaded, git);
  return (path) => isNoise(path) || own(path);
}

/**
 * The revision a request selects, judged the way `collectChangeContext` judges it. For
 * callers that read the same change the brief described, such as `handoff_source`.
 */
export function revisionFor(git: Git, loaded: LoadedConfig, request: RevisionRequest): Revision {
  return resolveRevision(git, { ...request, ignore: skipMatcher(loaded, git) });
}

function ownOutputMatcher(loaded: LoadedConfig, git: Git): (path: string) => boolean {
  // Relative to the git root, which is what diff paths are relative to; the config root
  // may be a package inside a monorepo. Resolved through symlinks on both sides.
  const directory = git.relativeToRoot(handoffDirectory(loaded));
  const config = loaded.path ? git.relativeToRoot(loaded.path) : null;
  return (path) =>
    path === (config ?? CONFIG_FILENAME) || (directory !== null && path.startsWith(`${directory}/`));
}

/**
 * Append a warning for the git failures recorded since `reported`, and return the new
 * watermark so the next call does not repeat them.
 */
function reportGitFailures(git: Git, warnings: string[], reported: number): number {
  const fresh = git.failures.slice(reported);
  if (fresh.length > 0) {
    warnings.push(`git did not answer, so this brief may be incomplete: ${fresh.join('; ')}`);
  }
  return git.failures.length;
}

/** All signals from all collectors, flattened. */
export function allSignals(context: ChangeContext): Signal[] {
  return context.results.flatMap((result) => result.signals);
}

/**
 * Signals the collectors flagged as possibly breaking.
 *
 * These are prompts for investigation, never verdicts: static heuristics cannot tell a
 * removed field from a renamed one, and a handoff that cries breaking-change wrongly is
 * worse than one that stays quiet.
 */
export function breakingCandidates(context: ChangeContext): Signal[] {
  return allSignals(context).filter((signal) => signal.kind === 'breaking-candidate');
}

const SIGNAL_TO_CHANGE_TYPE: Partial<Record<Signal['kind'], string>> = {
  api: 'api',
  auth: 'authentication',
  contract: 'contract',
  database: 'database',
  environment: 'environment',
  dependency: 'dependency',
  infrastructure: 'infrastructure',
  config: 'config',
};

/**
 * `change_type` values implied by the collected signals, for pre-filling frontmatter.
 * The generating agent is expected to correct this, not to trust it.
 */
export function inferChangeTypes(context: ChangeContext): string[] {
  const types = new Set<string>();
  for (const signal of allSignals(context)) {
    const type = SIGNAL_TO_CHANGE_TYPE[signal.kind];
    if (type) types.add(type);
  }
  if (types.size === 0) types.add('behavior');
  return [...types];
}
