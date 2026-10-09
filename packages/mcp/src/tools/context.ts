import { relative, resolve } from 'node:path';
import {
  briefToJson,
  collectChangeContext,
  Git,
  loadConfig,
  parseTargets,
  renderBrief,
  type CollectOptions,
  type LoadedConfig,
} from 'ryujin-handoff-core';
import { z } from 'zod';
import type { Boundary } from '../paths.ts';
import { contains, PathRefused, projectDir, realPath } from '../paths.ts';
import { guard, textResult, type ToolResult } from '../result.ts';

export const scopeShape = {
  base: z
    .string()
    .optional()
    .describe('Compare against this ref instead of the inferred trunk, e.g. "main".'),
  commits: z.number().int().positive().optional().describe('Describe the last N commits.'),
  since: z
    .string()
    .optional()
    .describe('Describe commits since a date expression, e.g. "3 weeks ago".'),
  staged: z.boolean().optional().describe('Only staged changes.'),
  working: z.boolean().optional().describe('Only uncommitted working-tree changes.'),
};

/**
 * Narrowing the change to part of the tree.
 *
 * Kept apart from {@link scopeShape} because `handoff_source` already has a `paths`
 * argument meaning "files to read", and one name doing two jobs in one schema is how a
 * model ends up passing the wrong list.
 */
export const pathScope = {
  scope_paths: z
    .array(z.string())
    .optional()
    .describe(
      'Limit the change to these repository-relative paths. Use this when the working tree holds more than one piece of work and the handoff should describe only part of it.',
    ),
};

export const contextInput = z.object({
  project_dir: z.string().describe('Absolute path to the repository the change is in.'),
  ...pathScope,
  target: z
    .string()
    .optional()
    .describe('Who the handoff is for, e.g. "mobile" or "web,devops".'),
  note: z
    .string()
    .optional()
    .describe("What the developer said they wanted the handoff to say, if anything."),
  ...scopeShape,
});

export type ContextInput = z.infer<typeof contextInput>;

/** Translate the tool's scope arguments into the options core expects. */
export function scopeOf(input: ContextInput): Partial<CollectOptions> {
  const scope: Partial<CollectOptions> = {};
  if (input.base) scope.base = input.base;
  if (input.commits) scope.commits = input.commits;
  if (input.since) scope.since = input.since;
  if (input.staged) scope.staged = true;
  if (input.working) scope.working = true;
  if (input.scope_paths?.length) scope.paths = input.scope_paths;
  return scope;
}

export const CONTEXT_DESCRIPTION = `Collect everything that can be determined about a change without judgment: the revision, the changed files, and pattern-matched signals about routes, auth guards, contracts, migrations, environment variables and dependencies.

Call this FIRST, before writing any handoff. It is fast, local, and reads nothing outside the repository.

What it returns is raw material, not a handoff. It reports what moved; it cannot say what any of it means to another team, and its "possible breaking changes" are regex matches that you must confirm or discard against the actual code.`;

/**
 * Keep a brief inside a pinned `--root`.
 *
 * git runs where the configuration lives, and a diff there covers the whole repository —
 * so a server pinned to one package of a monorepo would still describe, and quote in its
 * evidence lines, every other package. When the repository reaches past the pin, the
 * change is limited to the pinned tree, and any requested paths must lie inside it.
 */
export function boundedScope(
  boundary: Boundary,
  loaded: LoadedConfig,
  scope: Partial<CollectOptions>,
): Partial<CollectOptions> {
  if (!boundary.root) return scope;
  const gitRoot = new Git(loaded.root).root();
  if (!gitRoot || contains(boundary.root, realPath(gitRoot))) return scope;
  const from = realPath(loaded.root);
  if (scope.paths?.length) {
    for (const path of scope.paths) {
      if (!contains(boundary.root, realPath(resolve(from, path)))) {
        throw new PathRefused(`${path} is outside the pinned root ${boundary.root}.`);
      }
    }
    return scope;
  }
  return { ...scope, paths: [relative(from, boundary.root) || '.'] };
}

export function contextTool(boundary: Boundary) {
  return async (input: ContextInput): Promise<ToolResult> =>
    guard(() => {
      const cwd = projectDir(boundary, input.project_dir);
      const loaded = loadConfig(cwd);
      const context = collectChangeContext({
        cwd,
        loaded,
        targets: parseTargets(input.target ?? loaded.config.defaultTarget),
        note: input.note ?? null,
        ...boundedScope(boundary, loaded, scopeOf(input)),
      });
      // The rendered brief carries guidance the JSON does not — "Suggested reading", what the
      // brief cannot know — so it travels with the fields rather than being left out.
      return textResult(renderBrief(context), briefToJson(context));
    });
}
