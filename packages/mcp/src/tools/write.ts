import {
  collectChangeContext,
  composeHandoff,
  findSecrets,
  handoffDirectory,
  HandoffStore,
  KNOWN_CHANGE_TYPES,
  loadConfig,
  parseTargets,
  serializeHandoff,
  uniqueId,
  validateHandoff,
  VERSION,
  type HandoffBody,
} from 'ryujin-handoff-core';
import { z } from 'zod';
import type { Boundary } from '../paths.ts';
import { assertWithinBoundary, projectDir } from '../paths.ts';
import { errorResult, formatIssueList, guard, textResult, type ToolResult } from '../result.ts';
import { boundedScope, pathScope, scopeOf, scopeShape, type ContextInput } from './context.ts';

export const writeInput = z.object({
  project_dir: z.string().describe('Absolute path to the repository the change is in.'),

  title: z
    .string()
    .min(3)
    .describe('One line, in the consumer\'s vocabulary. "Refresh tokens are now single-use".'),
  targets: z
    .array(z.string())
    .describe('Who must act: ["mobile"], ["web","devops"]. Empty means any consumer.'),
  breaking: z
    .boolean()
    .describe(
      'True only if a consumer who changes nothing will now be wrong or broken. A judgment about behaviour, not about diff size. Confirm it against the code first.',
    ),
  change_type: z
    .array(z.string())
    .describe(`Open vocabulary. Known values: ${KNOWN_CHANGE_TYPES.join(', ')}.`),

  summary: z.string().describe('1-4 sentences. What changed, in the consumer\'s vocabulary.'),
  why_this_matters: z
    .string()
    .describe('The consequence of ignoring this. Not the engineering rationale.'),
  changes: z
    .string()
    .describe('The concrete behavioural delta. Prefer an explicit previous -> new contrast.'),
  required_actions: z
    .string()
    .describe(
      'The most important section. Numbered imperatives, one action each. With several targets, split with "### <target>" subsections and give each only what applies to it. "No action required" is a real answer.',
    ),
  verification: z
    .string()
    .describe(
      'How the receiver proves their own implementation is right. Name the scenario, not just "run the tests".',
    ),
  instructions_for_receiving_agent: z
    .string()
    .describe(
      'Second most important. You are writing to another coding agent in a codebase you have never seen. Say which existing module to modify rather than duplicate, what NOT to build, and what to report back if the contract does not match.',
    ),

  breaking_changes: z
    .string()
    .optional()
    .describe('Required when breaking is true. What fails for a consumer that does nothing.'),
  contracts: z.string().optional().describe('Endpoints, payloads, types, events. Small and exact.'),
  relevant_source: z
    .string()
    .optional()
    .describe('A short list of paths in the SOURCE repository, as markdown bullets.'),
  out_of_scope: z
    .string()
    .optional()
    .describe('What deliberately did not change. Cheap, and prevents over-implementation.'),
  notes: z.string().optional(),

  status: z
    .enum(['draft', 'ready'])
    .default('ready')
    .describe('Use "ready" for a finished document. "draft" only if you left something undecided.'),
  id: z.string().optional().describe('Explicit id. Defaults to YYYY-MM-DD-<slug of title>.'),
  author: z.string().optional(),
  overwrite: z
    .boolean()
    .default(false)
    .describe(
      'Replace an existing handoff with the same id. Only when the developer asked to update that handoff: one that already exists may have been sent, and is better left as it is beside a new one.',
    ),
  ...scopeShape,
  ...pathScope,
});

export type WriteInput = z.infer<typeof writeInput>;

/** What the developer needs in order to recognise a handoff that is in the way. */
function existingSummary(
  store: HandoffStore,
  id: string,
): { id: string; title: string; created_at: string; targets: string[] } {
  const found = store.lookup(id).found;
  return {
    id,
    title: found?.handoff.title ?? id,
    created_at: found?.handoff.frontmatter.created_at ?? 'at an unknown time',
    targets: found?.handoff.frontmatter.targets ?? [],
  };
}

export const WRITE_DESCRIPTION = `Write a finished HANDOFF.md and store it in the repository.

You supply only the prose. Everything factual — the schema version, id, timestamp, branch, commit and revision range — is taken from git, so it cannot be misremembered, and the section headings are generated, so they cannot drift from what the validator and the receiving side match on.

Call handoff_context first, and read the code before calling this. The document is validated before it is stored: if it does not conform, nothing is written and you get the errors back to fix. Nor is anything written over an existing handoff unless the developer chose to update it: a taken id comes back as a question to put to them.

Write in English unless the developer asked for another language or the project configured one.`;

export function writeTool(boundary: Boundary) {
  return async (input: WriteInput): Promise<ToolResult> =>
    guard(() => {
      const cwd = projectDir(boundary, input.project_dir);
      const loaded = loadConfig(cwd);
      const targets = input.targets.flatMap((target) => parseTargets(target));

      const context = collectChangeContext({
        cwd,
        loaded,
        targets,
        ...boundedScope(boundary, loaded, scopeOf(input as unknown as ContextInput)),
      });

      const body: HandoffBody = {
        Summary: input.summary,
        'Why This Matters': input.why_this_matters,
        Changes: input.changes,
        'Required Actions': input.required_actions,
        Verification: input.verification,
        'Instructions for Receiving Agent': input.instructions_for_receiving_agent,
        ...(input.breaking_changes ? { 'Breaking Changes': input.breaking_changes } : {}),
        ...(input.contracts ? { Contracts: input.contracts } : {}),
        ...(input.relevant_source ? { 'Relevant Source': input.relevant_source } : {}),
        ...(input.out_of_scope ? { 'Out of Scope': input.out_of_scope } : {}),
        ...(input.notes ? { Notes: input.notes } : {}),
      };

      const handoff = composeHandoff({
        context,
        title: input.title,
        targets,
        breaking: input.breaking,
        changeType: input.change_type,
        body,
        status: input.status,
        generatedBy: `agents-handoff/${VERSION} (mcp)`,
        ...(input.author ? { author: input.author } : {}),
        ...(input.id ? { id: input.id } : {}),
      });

      const directory = handoffDirectory(loaded);
      assertWithinBoundary(boundary, directory, 'The handoff directory for this project');
      const store = new HandoffStore(directory);
      // A taken id is a decision for the developer, not for this tool or the agent: the
      // earlier handoff may already have been sent. Silently filing a second copy left two
      // near-identical documents; silently replacing lost one.
      const taken = store.exists(handoff.frontmatter.id) && !input.overwrite ? existingSummary(store, handoff.frontmatter.id) : null;
      if (taken) {
        const alternative = uniqueId(handoff.frontmatter.id, (id) => store.exists(id));
        return errorResult(
          `Not stored — a handoff with id "${taken.id}" already exists: "${taken.title}", written ${taken.created_at}, for ${taken.targets.join(', ') || 'any consumer'}.\n\n` +
            'Ask the developer which they want, with your question tool if you have one — it may already have been sent:\n' +
            `- update it: call handoff_write again with id: "${taken.id}" and overwrite: true\n` +
            `- keep both: call handoff_write again with id: "${alternative}"`,
          { ok: false, exists: taken, alternative_id: alternative },
        );
      }

      // Validate before storing. A non-conforming handoff on disk is worse than none: the
      // developer believes the work is done.
      const validation = validateHandoff(handoff);
      if (!validation.ok) {
        return errorResult(
          `Not stored — this does not conform to the v1 schema:\n\n${formatIssueList(validation.errors)}\n\nFix these and call handoff_write again.`,
          { ok: false, errors: validation.errors },
        );
      }

      const markdown = serializeHandoff(handoff);
      const secrets = findSecrets(markdown);
      if (secrets.length > 0) {
        return errorResult(
          `Not stored — this looks like it contains a credential:\n${secrets
            .map((finding) => `- line ${finding.line}: ${finding.kind} (${finding.preview})`)
            .join('\n')}`,
          { ok: false, secrets },
        );
      }

      const path = store.save(handoff);
      const notes = validation.warnings.length
        ? `\n\nWorth a look before you send it:\n${formatIssueList(validation.warnings)}`
        : '';

      return textResult(
        `Wrote ${path}\n\n` +
          `id: ${handoff.frontmatter.id}\n` +
          `targets: ${targets.join(', ') || 'any consumer'}\n` +
          `breaking: ${input.breaking}\n` +
          `Now call handoff_delivery_options to see how this project reaches ${targets.join(', ') || 'this consumer'}, ` +
          `and offer the developer a specific route. Do not deliver without being asked.${notes}`,
        {
          ok: true,
          id: handoff.frontmatter.id,
          path,
          targets,
          breaking: input.breaking,
          warnings: validation.warnings,
        },
      );
    });
}
