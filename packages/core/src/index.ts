/**
 * Agents Handoff core.
 *
 * Everything here is agent-independent and free of model calls: schema, Markdown format,
 * git inspection, context collection, validation, storage and Markdown export. Integrations
 * (Claude Code today, others later) and the CLI are thin layers on top of this package.
 */

import { readFileSync as readVersionFile } from 'node:fs';
import { join as joinVersionPath } from 'node:path';
import { packageRootOf as versionRootOf } from './util/fs.ts';

/**
 * This package's own version, read from its package.json. A literal here was one more
 * thing to bump by hand, and forgetting it made a new release report the old number.
 */
export const VERSION: string = (
  JSON.parse(readVersionFile(joinVersionPath(versionRootOf(import.meta.url), 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

export * from './constants.ts';
export * from './types.ts';

export { splitFrontmatter, parseFrontmatterYaml, stringifyFrontmatterYaml, FrontmatterParseError } from './markdown/frontmatter.ts';
export { parseBody, findSection, hasContent, extractCodeBlocks } from './markdown/sections.ts';
export type { BodyStructure, CodeBlock } from './markdown/sections.ts';
export { parseHandoff, isSupportedHandoff, HandoffParseError } from './markdown/parse.ts';
export { serializeHandoff, frontmatterToRecord } from './markdown/serialize.ts';

export { validateHandoff, validateHandoffSource, formatIssues, isIsoTimestamp } from './schema/validate.ts';

export {
  defaultConfig,
  loadConfig,
  mergeConfig,
  writeConfig,
  handoffDirectory,
  ensureGitignored,
  removeFromGitignore,
} from './config/index.ts';
export type { HandoffConfig, ContextConfig, LoadedConfig, GitignoreResult, AskPolicy } from './config/index.ts';
export { ASK_POLICIES } from './config/index.ts';

export { Git, repoHost, repoSlug, parseNumstatPath } from './git/index.ts';
export type { Commit, ChangedFile, FileStatus, Revision, RepoInfo } from './git/index.ts';

export { BUILTIN_COLLECTORS, collectorsFor } from './collectors/index.ts';
export type { Collector, CollectorContext, CollectorResult, Signal, SignalKind } from './collectors/types.ts';
export { classifyPath, classifyAll, isNoise, pathsInCategory } from './collectors/classify.ts';
export type { FileCategory, Classification } from './collectors/classify.ts';
export { parseUnifiedDiff, trulyAdded, trulyRemoved } from './collectors/diff.ts';
export type { FileDiff } from './collectors/diff.ts';
export { detectTestCommand } from './collectors/tests.ts';

export { resolveRevision } from './context/revision.ts';
export type { RevisionRequest } from './context/revision.ts';
export {
  collectChangeContext,
  revisionFor,
  skipMatcher,
  allSignals,
  breakingCandidates,
  inferChangeTypes,
} from './context/collect.ts';
export type { ChangeContext, CollectOptions } from './context/collect.ts';
export { renderBrief, briefToJson } from './context/brief.ts';

export { scaffoldHandoff, suggestId } from './generate/scaffold.ts';
export type { ScaffoldOptions } from './generate/scaffold.ts';
export { renderAuthoringGuide, renderReceivingGuide } from './guidance/render.ts';
export type { Mechanics, RenderOptions } from './guidance/render.ts';
export {
  AUTHORING_STEPS,
  RECEIVING_STEPS,
  AUTHORING_INTRO,
  RECEIVING_INTRO,
  ARGUMENT_GUIDANCE,
} from './guidance/steps.ts';
export type { Step } from './guidance/steps.ts';

export { composeHandoff } from './generate/compose.ts';
export type { ComposeOptions, HandoffBody } from './generate/compose.ts';

export {
  HandoffStore,
  UnusableHandoffId,
  assertUsableId,
  blockingStorageErrors,
  derivedHandoffId,
  isUsableId,
} from './storage/index.ts';
export type {
  StoredHandoff,
  BrokenHandoff,
  ListResult,
  Direction,
  IncomingSaveResult,
} from './storage/index.ts';

export { analyzeReceived, renderReceiveBrief, extractTargetActions } from './receive/index.ts';
export type { ReceiveAnalysis, ReceiveOptions } from './receive/index.ts';

export { exportHandoff, ExportHandoffError } from './export/index.ts';
export type { ExportHandoffOptions, ExportHandoffResult } from './export/index.ts';

export { normalizeTarget, parseTargets, SUGGESTED_TARGETS } from './targets.ts';
export { findSecrets, mask } from './redact.ts';
export type { SecretFinding } from './redact.ts';

export { slugify, buildHandoffId, uniqueId, datePrefix } from './util/slug.ts';
export { countWords, normalizeHeading, tidyMarkdown, markdownTable, truncate, unique } from './util/text.ts';
export { packageRootOf, findUp, writeTextFile, readTextIfExists, readJsonIfExists } from './util/fs.ts';
export { which, clearWhichCache } from './util/which.ts';
