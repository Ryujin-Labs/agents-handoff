import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeReceived,
  blockingStorageErrors,
  defaultConfig,
  ensureGitignored,
  exportHandoff,
  findSecrets,
  Git,
  handoffDirectory,
  HandoffStore,
  loadConfig,
  parseHandoff,
  parseTargets,
  renderReceiveBrief,
  serializeHandoff,
  validateHandoffSource,
  writeConfig,
  type StoredHandoff,
} from 'ryujin-handoff-core';
import { z } from 'zod';
import type { Boundary } from '../paths.ts';
import { assertWithinBoundary, contains, insideProject, PathRefused, projectDir, realPath } from '../paths.ts';
import { errorResult, formatIssueList, guard, textResult, type ToolResult } from '../result.ts';

const project = z.string().describe('Absolute path to the repository.');

/**
 * The handoff store for a project, refused when it lies outside the pinned `--root`.
 * `project_dir` is checked on the way in, but the configuration decides where handoffs
 * are written — the git root of a monorepo, for one — and every write lands there.
 */
function storeFor(boundary: Boundary, cwd: string): HandoffStore {
  const directory = handoffDirectory(loadConfig(cwd));
  assertWithinBoundary(boundary, directory, 'The handoff directory for this project');
  return new HandoffStore(directory);
}

/**
 * A stored handoff by id, or by an unambiguous part of one — never by path. An argument
 * chosen by a model that could name a path would reach any file this process can read.
 */
function findStored(store: HandoffStore, id: string): StoredHandoff | ToolResult {
  const { found, ambiguous } = store.lookup(id);
  if (found) return found;
  return errorResult(
    ambiguous.length > 1
      ? `"${id}" matches more than one handoff: ${ambiguous.join(', ')}. Pass the full id.`
      : `No handoff with id "${id}". handoff_list shows what exists.`,
  );
}

function isResult(value: StoredHandoff | ToolResult): value is ToolResult {
  return 'content' in value;
}

/* ------------------------------------------------------------------ list */

export const listInput = z.object({
  project_dir: project,
  direction: z.enum(['outgoing', 'inbox', 'all']).default('outgoing'),
});

export const LIST_DESCRIPTION = `List handoffs stored in a repository: the ones written here ("outgoing"), the ones received from other teams ("inbox"), or both.

Each entry shows its targets, whether it is breaking, and its status, so you can find one without reading them all.`;

export function listTool(boundary: Boundary) {
  return async (input: z.infer<typeof listInput>): Promise<ToolResult> =>
    guard(() => {
      const cwd = projectDir(boundary, input.project_dir);
      const store = storeFor(boundary, cwd);
      const { handoffs, broken } = store.list(input.direction);
      if (handoffs.length === 0 && broken.length === 0) {
        return textResult('No handoffs in this repository yet.', { handoffs: [] });
      }
      const rows = handoffs.map((entry) => ({
        id: entry.id,
        title: entry.handoff.title,
        direction: entry.direction,
        targets: entry.handoff.frontmatter.targets,
        breaking: entry.handoff.frontmatter.breaking,
        status: entry.handoff.frontmatter.status,
        created_at: entry.handoff.frontmatter.created_at,
      }));
      const text = rows
        .map(
          (row) =>
            `${row.id}  [${row.targets.join(',') || 'any'}]${row.breaking ? ' breaking' : ''}${row.status !== 'ready' ? ` ${row.status}` : ''}\n  ${row.title}`,
        )
        .join('\n');
      return textResult(text, { handoffs: rows, broken });
    });
}

/* ------------------------------------------------------------------ read */

export const readInput = z.object({
  project_dir: project,
  id: z.string().describe('Handoff id, or an unambiguous part of one.'),
});

export const READ_DESCRIPTION = `Read one stored handoff back in full, by id or by an unambiguous part of one.

Use it to show a developer what was written, to check a handoff before exporting it, or to pick up work described in an earlier one.`;

export function readTool(boundary: Boundary) {
  return async (input: z.infer<typeof readInput>): Promise<ToolResult> =>
    guard(() => {
      const cwd = projectDir(boundary, input.project_dir);
      const found = findStored(storeFor(boundary, cwd), input.id);
      if (isResult(found)) return found;
      return textResult(serializeHandoff(found.handoff), { id: found.id, path: found.path });
    });
}

/* --------------------------------------------------------------- receive */

export const receiveInput = z.object({
  project_dir: project,
  file_path: z
    .string()
    .optional()
    .describe(
      'Path to a handoff inside this project. For one anywhere else — Downloads, a chat attachment — read it yourself and pass its contents as markdown instead; this server does not read outside the project.',
    ),
  markdown: z
    .string()
    .optional()
    .describe('The handoff as text: pasted, or read from a file outside the project. Either this or file_path is required.'),
  as: z
    .string()
    .optional()
    .describe('Which consumer this repository is, so Required Actions can be narrowed.'),
  store: z.boolean().default(true).describe('Keep a copy under .handoff/inbox.'),
});

export const RECEIVE_DESCRIPTION = `Read a handoff someone else's agent wrote and work out what it means for THIS repository.

Returns the document reordered for a reader who has to act: whether it concerns this repo, then Required Actions narrowed to your target, then the rest.

After calling this, search this codebase for the endpoints, types and variables it names before planning any work. Three answers are all fine: it applies and here is the plan, it does not apply and here is what you searched for, or you cannot tell and here is why.`;

export function receiveTool(boundary: Boundary) {
  return async (input: z.infer<typeof receiveInput>): Promise<ToolResult> =>
    guard(() => {
      const cwd = projectDir(boundary, input.project_dir);
      const loaded = loadConfig(cwd);

      let source: string;
      if (input.markdown?.trim()) {
        source = input.markdown;
      } else if (input.file_path) {
        let full: string;
        try {
          full = insideProject(cwd, input.file_path);
        } catch (error) {
          if (!(error instanceof PathRefused)) throw error;
          // The usual place for a handoff someone sent is Downloads, not the repository.
          // This server only reads inside the project, so say how to get it in rather than
          // leaving the agent with a refusal and no next step.
          return errorResult(
            `${error.message} This server only reads files inside the project. Read the file yourself and pass its contents as \`markdown\` — or copy it into the project and pass that path.`,
          );
        }
        if (!existsSync(full)) return errorResult(`No such file: ${input.file_path}`);
        source = readFileSync(full, 'utf8');
      } else {
        return errorResult('Pass either file_path or markdown.');
      }

      const validation = validateHandoffSource(source);
      if (!validation.handoff) {
        return errorResult(
          `That is not a v1 handoff:\n${formatIssueList(validation.errors)}`,
          { ok: false, errors: validation.errors },
        );
      }

      // `identity` is which consumer this repository is. `defaultTarget` says who it sends
      // to, which is the opposite end of the arrow and not an answer to this question.
      const as = input.as ?? loaded.config.identity;
      const analysis = analyzeReceived(validation.handoff, {
        as,
        project: loaded.config.project,
      });

      // Store only a conforming document, and never let its own id choose the path: both
      // are decisions about a file another team wrote. See `blockingStorageErrors`.
      const blocking = blockingStorageErrors(validation);
      // A credential in another team's handoff is their leak; filing it here would commit
      // it into this repository too. The brief is still read, the copy is not kept.
      const secrets = findSecrets(source);
      let storedAt: string | null = null;
      let storedAs: string | null = null;
      let renamedFrom: string | null = null;
      let renamedBecause: string | null = null;
      if (input.store && blocking.length === 0 && secrets.length === 0) {
        const saved = storeFor(boundary, cwd).saveIncoming(validation.handoff);
        storedAt = saved.path;
        storedAs = saved.id;
        renamedFrom = saved.renamedFrom;
        renamedBecause = saved.renamedBecause;
      }

      const brief = renderReceiveBrief(analysis, { project: loaded.config.project });
      const secretNote = secrets.length
        ? `\n\nNot stored: this looks like it contains a credential (line ${secrets[0]?.line}, ${secrets[0]?.kind}). Tell the developer, so the sender can rotate it and send a clean copy.`
        : '';
      const note = secretNote ? secretNote : renamedFrom
        ? renamedBecause === 'taken'
          ? `\n\nFiled as ${storedAs}: a handoff from another sender already uses "${renamedFrom}".`
          : `\n\nFiled as ${storedAs}: the id this document declared cannot be a directory name.`
        : input.store && !storedAt
          ? `\n\nNot stored: this document does not conform to the v1 schema.\n${formatIssueList(blocking)}`
          : '';

      return textResult(`${brief}${note}`, {
        id: validation.handoff.frontmatter.id,
        applies: analysis.applies,
        breaking: validation.handoff.frontmatter.breaking,
        valid: validation.ok,
        stored_at: storedAt,
        stored_as: storedAs,
        renamed_from: renamedFrom,
        actions_for_target: analysis.actionsForTarget,
        secrets,
      });
    });
}

/* ---------------------------------------------------------------- export */

export const exportInput = z.object({
  project_dir: project,
  id: z.string().describe('Stored handoff id, or an unambiguous part of one.'),
  output_path: z.string().optional().describe(
    'Optional Markdown file or existing directory inside this project. Defaults to .handoff/exports/<id>.md.',
  ),
});

export const EXPORT_DESCRIPTION = `Export a finished stored handoff as a local Markdown file and return its complete contents.

The exported file preserves the source document byte for byte, including its status. The result includes the absolute file path and full Markdown. An optional output_path must remain inside this project; existing unrelated files are never replaced.`;

export function exportTool(boundary: Boundary) {
  return async (input: z.infer<typeof exportInput>): Promise<ToolResult> =>
    guard(() => {
      const cwd = projectDir(boundary, input.project_dir);
      const store = storeFor(boundary, cwd);
      const found = findStored(store, input.id);
      if (isResult(found)) return found;
      assertWithinBoundary(boundary, found.path, 'The stored handoff');
      if (!contains(realPath(store.directory), realPath(found.path))) {
        throw new PathRefused('The stored handoff is outside the handoff directory. Nothing was exported.');
      }
      const exportDir = join(store.directory, 'exports');
      assertWithinBoundary(boundary, exportDir, 'The export directory');
      if (!contains(realPath(store.directory), realPath(exportDir))) {
        throw new PathRefused('The export directory is outside the handoff directory. Nothing was exported.');
      }
      const outputPath = input.output_path ? insideProject(cwd, input.output_path) : undefined;
      if (outputPath) assertWithinBoundary(boundary, outputPath, 'The output path');
      const result = exportHandoff({
        markdown: readFileSync(found.path, 'utf8'),
        cwd,
        exportDir,
        sourcePath: found.path,
        ...(outputPath ? { outputPath } : {}),
      });
      return textResult(result.markdown, {
        id: result.id,
        path: result.path,
        source_path: found.path,
        markdown: result.markdown,
        content: result.markdown,
      });
    });
}

/* ----------------------------------------------------------------- setup */

export const setupInput = z.object({
  project_dir: project,
  project_name: z.string().optional().describe('Logical name, e.g. "backend".'),
  targets: z.array(z.string()).optional().describe('Consumers this project hands off to.'),
  language: z
    .string()
    .optional()
    .describe('Language for handoff prose. Omit for English, which is the default.'),
  keep_local: z
    .boolean()
    .default(false)
    .describe('True adds .handoff/ to .gitignore instead of committing handoffs.'),
  overwrite: z
    .boolean()
    .default(false)
    .describe('Replace an existing handoff.config.json. Only replace it when the developer asks.'),
});

export const SETUP_DESCRIPTION = `Create handoff.config.json and the .handoff directory.

Optional: every other tool works on defaults without it. Only run it when the developer asks to set the project up, and ask them whether handoffs should be committed to git before choosing.`;

export function setupTool(boundary: Boundary) {
  return async (input: z.infer<typeof setupInput>): Promise<ToolResult> =>
    guard(() => {
      const cwd = projectDir(boundary, input.project_dir);
      // The config goes at the git root, where every tool finds it — unless that root is
      // outside the pinned tree, in which case it goes where the server is allowed to write.
      const gitRoot = new Git(cwd).root();
      const root =
        gitRoot && (!boundary.root || contains(boundary.root, realPath(gitRoot))) ? gitRoot : cwd;
      const existing = loadConfig(root);
      if (existing.exists && existing.path && !input.overwrite) {
        return errorResult(
          `${existing.path} already exists. Nothing was changed. Pass overwrite: true only if the developer wants it replaced.`,
          { path: existing.path, config: existing.config },
        );
      }
      const config = defaultConfig(input.project_name ?? root.split('/').pop() ?? 'project');
      if (input.targets?.length) config.targets = input.targets.flatMap((t) => parseTargets(t));
      if (input.language?.trim()) config.language = input.language.trim();
      config.gitignore = input.keep_local;

      const path = writeConfig(root, config);
      new HandoffStore(handoffDirectory(loadConfig(root))).ensure();
      if (input.keep_local) ensureGitignored(root, config.directory);

      return textResult(
        `Wrote ${path}\nproject: ${config.project}\ntargets: ${config.targets.join(', ') || '(none)'}\nlanguage: ${config.language ?? 'English'}\nhandoffs are ${input.keep_local ? 'gitignored' : 'committed to git'}`,
        { path, config },
      );
    });
}

/* -------------------------------------------------------------- validate */

export const validateInput = z.object({
  project_dir: project,
  id: z.string().optional().describe('A stored handoff id.'),
  markdown: z.string().optional().describe('A handoff as text, to check before storing it.'),
  strict: z.boolean().default(false).describe('Treat warnings as failures.'),
});

export const VALIDATE_DESCRIPTION =
  'Check a handoff against the v1 schema. handoff_write already validates before storing, so use this to check a document someone sent you, or one edited by hand.';

export function validateTool(boundary: Boundary) {
  return async (input: z.infer<typeof validateInput>): Promise<ToolResult> =>
    guard(() => {
      const cwd = projectDir(boundary, input.project_dir);
      let source: string;
      if (input.markdown?.trim()) {
        source = input.markdown;
      } else if (input.id) {
        const found = findStored(storeFor(boundary, cwd), input.id);
        if (isResult(found)) return found;
        source = readFileSync(found.path, 'utf8');
      } else {
        return errorResult('Pass either id or markdown.');
      }

      const result = validateHandoffSource(source);
      // The same verdict as the CLI: a document carrying a credential does not pass.
      const secrets = findSecrets(source);
      const lines: string[] = [];
      if (result.errors.length) lines.push(`Errors:\n${formatIssueList(result.errors)}`);
      if (secrets.length) {
        lines.push(
          `Credentials:\n${secrets.map((finding) => `- line ${finding.line}: possible ${finding.kind} (${finding.preview})`).join('\n')}`,
        );
      }
      if (result.warnings.length) lines.push(`Warnings:\n${formatIssueList(result.warnings)}`);
      if (lines.length === 0) lines.push('Valid, with no warnings.');

      const failed = !result.ok || secrets.length > 0 || (input.strict && result.warnings.length > 0);
      const text = lines.join('\n\n');
      // The verdict, not the document: the caller already has that, and echoing it back
      // would repeat any credential just reported as masked.
      const structured = {
        id: result.handoff?.frontmatter.id ?? null,
        ok: result.ok && secrets.length === 0,
        errors: result.errors,
        warnings: result.warnings,
        secrets,
      };
      return failed ? errorResult(text, structured) : textResult(text, structured);
    });
}

/** Re-exported so the server can list every parser in one place. */
export { parseHandoff };
