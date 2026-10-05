import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeReceived,
  blockingStorageErrors,
  channelWithSettings,
  configProblems,
  defaultConfig,
  deliveryOptions,
  ensureGitignored,
  findSecrets,
  formatDeliveryOptions,
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
} from 'agents-handoff-core';
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

function textOf(result: ToolResult): string {
  return result.content.map((part) => ('text' in part ? part.text : '')).join('\n');
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

Use it to show a developer what was written, to check a handoff before delivering it, or to pick up work described in an earlier one.`;

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

/* --------------------------------------------------------------- deliver */

export const optionsInput = z.object({
  project_dir: project,
  id: z.string().optional().describe('A stored handoff, so routes match its targets.'),
  targets: z.array(z.string()).optional().describe('Targets to look up routes for.'),
});

export const OPTIONS_DESCRIPTION = `List the ways this handoff can be delivered, and which are actually configured.

Call this before you tell the developer their handoff is ready. "You can share this now" is not an instruction; naming the route their project set up for this target is. Routes marked "routed" are what this project decided reaches this team.

Channels marked "compose" open an app with the message ready and the developer presses send; "push" channels deliver directly and upload the handoff to a third party.`;

export function optionsTool(boundary: Boundary) {
  return async (input: z.infer<typeof optionsInput>): Promise<ToolResult> =>
    guard(() => {
      const cwd = projectDir(boundary, input.project_dir);
      const loaded = loadConfig(cwd);

      let targets = input.targets ?? [];
      if (targets.length === 0 && input.id) {
        const found = findStored(storeFor(boundary, cwd), input.id);
        if (isResult(found)) return found;
        targets = found.handoff.frontmatter.targets;
      }

      const options = deliveryOptions(loaded.config, targets).filter((option) => option.id !== 'stdout');
      const routed = options.filter((option) => option.routed);
      const header = routed.length
        ? `Configured for ${targets.join(', ') || 'this project'}: ${routed.map((o) => o.label ?? o.id).join(', ')}.`
        : `No routes configured for ${targets.join(', ') || 'this project'}. Anything available below still works, and routes can be set once in handoff.config.json.`;
      const problems = configProblems(loaded.config);
      const warnings = problems.length
        ? `\n\nConfiguration problems to mention to the developer:\n${problems.map((problem) => `- ${problem}`).join('\n')}`
        : '';

      return textResult(`${header}\n\n${formatDeliveryOptions(options)}${warnings}`, {
        targets,
        options,
        config_problems: problems,
      });
    });
}

export const deliverInput = z.object({
  project_dir: project,
  id: z.string().optional().describe('One handoff to deliver.'),
  ids: z
    .array(z.string())
    .optional()
    .describe(
      'Several handoffs at once. Each goes to the route configured for its own target, so one change split across teams is delivered in one call.',
    ),
  open: z
    .boolean()
    .default(true)
    .describe('Open the chat or mail window, and show the file ready to attach.'),
  link: z
    .enum(['repo', 'gist', 'none'])
    .optional()
    .describe(
      'What URL goes in the message, for whatsapp and email. "repo" links to the handoff where it is already committed — readable by whoever can read the repository and nobody else, and nothing is uploaded; it needs the handoff pushed. "gist" uploads a secret gist, which is unlisted but readable by ANYONE who comes by the URL. "none" puts no link in and the developer attaches the file. Say which you are using and who can read it; do not describe a gist as private.',
    ),
  channel: z
    .string()
    .optional()
    .describe(
      'Channel id from handoff_delivery_options. Omit to use the route configured for this handoff\'s target.',
    ),
  to: z
    .string()
    .optional()
    .describe('Destination: a path for "file", a phone number for "whatsapp", an address for "email".'),
});

export const DELIVER_DESCRIPTION = `Deliver one or more stored handoffs.

Pass \`ids\` to deliver several at once — one change often produces a handoff per team, and each goes to the route configured for its own target.

Local channels (clipboard, file, text) upload nothing. Push channels (slack, discord, trello, github) send the handoff to a third party. Compose channels (whatsapp, email) open the app with a line ready and put the handoff on the clipboard, so one paste attaches it — the developer presses send.

**Ask the developer before calling this**, using your question UI so they can pick rather than type. Delivery leaves the machine and is their decision. Call handoff_delivery_options first so the choices you offer are the ones this project actually configured.`;

export function deliverTool(boundary: Boundary) {
  return async (input: z.infer<typeof deliverInput>): Promise<ToolResult> =>
    guard(async () => {
      const cwd = projectDir(boundary, input.project_dir);
      const wanted = [...(input.ids ?? []), ...(input.id ? [input.id] : [])];
      if (wanted.length === 0) return errorResult('Pass id, or ids for several at once.');

      const deliveries: Delivery[] = [];
      for (const one of wanted) {
        deliveries.push(...(await deliverOne(boundary, cwd, { ...input, id: one })));
      }

      const labelled = deliveries.length > 1;
      const text = deliveries
        .map((entry) => (labelled ? `${entry.id} → ${entry.channel}: ${entry.message}` : entry.message))
        .join('\n\n');
      // One delivery keeps its fields at the top level; several are listed, so none of
      // them loses its link or its "who can read this" on the way to the model.
      const first = deliveries[0];
      const structured = deliveries.length === 1 && first ? { ...first, deliveries } : { deliveries };
      return deliveries.every((entry) => entry.ok)
        ? textResult(text, structured)
        : errorResult(text, structured);
    });
}

/** What happened to one handoff on one channel. */
interface Delivery {
  [key: string]: unknown;
  id: string;
  channel: string;
  ok: boolean;
  /** True only when something actually left the machine. A draft opened is not sent. */
  sent: boolean;
  message: string;
  destination?: string | undefined;
  url?: string | undefined;
  share_url?: string | undefined;
  share_visibility?: string | undefined;
  /** Where the handoff was uploaded on the way — a secret gist — even when not sent. */
  uploaded?: string | undefined;
  next_step?: string | undefined;
}

/** Never offered or reached here: stdout is this server's protocol stream. */
const UNOFFERED = new Set(['stdout']);

async function deliverOne(
  boundary: Boundary,
  cwd: string,
  input: z.infer<typeof deliverInput> & { id: string },
): Promise<Delivery[]> {
  const refuse = (message: string, channel = input.channel ?? ''): Delivery[] => [
    { id: input.id, channel, ok: false, sent: false, message },
  ];

  const found = findStored(storeFor(boundary, cwd), input.id);
  if (isResult(found)) return refuse(textOf(found));

  const markdown = readFileSync(found.path, 'utf8');
  const secrets = findSecrets(markdown);
  if (secrets.length > 0) {
    return refuse(
      `Refusing to deliver: this looks like it contains a credential (line ${secrets[0]?.line}, ${secrets[0]?.kind}).`,
    );
  }

  // Hold delivery to the same bar the CLI does: a document that does not conform, or
  // that is still the scaffold it started as, is not something to hand a teammate.
  const validation = validateHandoffSource(markdown);
  if (!validation.ok) {
    return refuse(
      `Refusing to deliver a handoff that does not conform to the v1 schema:\n${formatIssueList(validation.errors)}\n\nFix it with handoff_write (overwrite: true), then deliver.`,
    );
  }
  const scaffold = validation.warnings.find((issue) => issue.code === 'unfilled-template');
  if (scaffold) {
    return refuse(
      `Refusing to deliver a scaffold: ${scaffold.message} Write the finished document with handoff_write (overwrite: true), then deliver.`,
    );
  }

  if (input.channel === 'text') {
    return [{ id: found.id, channel: 'text', ok: true, sent: false, message: markdown }];
  }

  const loaded = loadConfig(cwd);
  const options = deliveryOptions(loaded.config, found.handoff.frontmatter.targets);

  // No channel named: every route this project configured for the handoff's targets, not
  // just the first one found. A handoff for mobile and web goes to both teams' routes. A
  // route to stdout stays in the list so that it is refused out loud, not dropped.
  const routed = options.filter((option) => option.routed);
  const channelIds = input.channel
    ? [input.channel]
    : routed.length > 0
      ? routed.map((option) => option.id)
      : ['clipboard'];

  const deliveries: Delivery[] = [];
  for (const channelId of channelIds) {
    if (UNOFFERED.has(channelId)) {
      deliveries.push(...refuse(
        'Refusing to deliver to stdout: stdout is the MCP JSON-RPC protocol stream, not a delivery channel. Use "text" to return the handoff in tool output.',
        channelId,
      ));
      continue;
    }
    const resolved = channelWithSettings(loaded.config, channelId);
    if (!resolved) {
      deliveries.push(...refuse(`Unknown channel "${channelId}". Call handoff_delivery_options to see what exists.`, channelId));
      continue;
    }
    const { channel, settings } = resolved;
    if (!channel.isAvailable(settings)) {
      const option = options.find((entry) => entry.id === channelId);
      deliveries.push(...refuse(`The "${channelId}" channel is not usable here: ${option?.blockedBy ?? 'unavailable'}.`, channelId));
      continue;
    }

    // A copy to attach, or a file delivery with no `to`, goes in the project's outbox, never
    // the system temp directory: this server writes only inside the project it was given.
    const stagingDir = join(handoffDirectory(loaded), 'outbox');
    assertWithinBoundary(boundary, stagingDir, 'The outbox');

    // `to` is a path for the file channel, held to the same boundary as every read.
    let destination = input.to;
    if (channelId === 'file' && input.to) destination = insideProject(cwd, input.to);

    const result = await channel.send({
      markdown,
      handoff: found.handoff,
      sourcePath: found.path,
      cwd,
      settings,
      open: input.open,
      stagingDir,
      ...(input.link ? { link: input.link } : {}),
      ...(destination ? { destination } : {}),
    });
    // Who can read the link, and any upload it took, go in the words too: an agent that
    // reads only the message must still be able to tell the developer.
    const disclosure = [
      result.uploaded ? `Uploaded to ${result.uploaded} on the way.` : '',
      result.shareVisibility ? `The link is readable by ${result.shareVisibility}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
    deliveries.push({
      id: found.id,
      channel: channelId,
      ok: result.ok,
      sent: result.ok && !result.composed && channel.kind !== 'local',
      message: `${result.message || `Delivered to ${result.destination}.`}${disclosure ? ` ${disclosure}` : ''}`,
      uploaded: result.uploaded,
      destination: result.destination,
      url: result.url,
      share_url: result.shareUrl,
      share_visibility: result.shareVisibility,
      next_step: result.nextStep,
    });
  }
  return deliveries;
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
    .describe('Replace an existing handoff.config.json. It holds routes and channels; only with the developer\'s say-so.'),
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
          `${existing.path} already exists, with its routes and channels. Nothing was changed. Pass overwrite: true only if the developer wants it replaced.`,
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
