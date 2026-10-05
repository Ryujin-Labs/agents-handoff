import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { Git, loadConfig, revisionFor } from 'agents-handoff-core';
import { z } from 'zod';
import type { Boundary } from '../paths.ts';
import { holdsCredential, insideProject, isSecretish, projectDir } from '../paths.ts';
import { errorResult, guard, textResult, type ToolResult } from '../result.ts';
import { scopeOf, scopeShape, type ContextInput } from './context.ts';

const MAX_BYTES = 200_000;

export const sourceInput = z.object({
  project_dir: z.string().describe('Absolute path to the repository.'),
  paths: z
    .array(z.string())
    .min(1)
    .max(10)
    .describe('Repository-relative file paths to read, at most 10.'),
  mode: z
    .enum(['current', 'diff'])
    .default('current')
    .describe(
      '"current" returns each file as it stands now. "diff" returns what changed in them for the given revision.',
    ),
  ...scopeShape,
});

export type SourceInput = z.infer<typeof sourceInput>;

export const SOURCE_DESCRIPTION = `Read specific files from the repository, or the diff for them.

Use this after handoff_context, on the files it lists under "Suggested reading". A handoff written from the context brief alone is guesswork: the brief reports that lines moved, and only the code says what the behaviour now is. This is also how you confirm or discard each "possible breaking change" before deciding whether the change is breaking.

Confined to the given project directory. Files that exist to hold credentials are refused.`;

export function sourceTool(boundary: Boundary) {
  return async (input: SourceInput): Promise<ToolResult> =>
    guard(() => {
      const cwd = projectDir(boundary, input.project_dir);
      const git = new Git(cwd);

      if (input.mode === 'diff') {
        if (!git.isRepo()) return errorResult(`${cwd} is not a git repository.`);
        // The same revision handoff_context described, judged the same way.
        const revision = revisionFor(git, loadConfig(cwd), scopeOf(input as ContextInput));
        // Paths still go through the boundary check: they reach git as arguments. They also
        // go as *literal* pathspecs, or a model-chosen `.en?` or `*` would expand into files
        // this tool refuses by name. A directory still matches everything under it, so files
        // that hold credentials are taken out of the diff as well.
        const safe = input.paths.map(
          (path) => `:(literal)${relative(cwd, insideProject(cwd, path)) || '.'}`,
        );
        const { diff, withheld } = withoutSecretFiles(git.diff(revision, safe, 3));
        const note = withheld.length
          ? `\n\n(Withheld ${withheld.length} file(s) that exist to hold credentials: ${withheld.join(', ')}.)`
          : '';
        return diff.trim()
          ? textResult(`${diff}${note}`)
          : textResult(
              `No changes in those paths for ${revision.spec} (${revision.description}).${note}`,
            );
      }

      const parts: string[] = [];
      for (const path of input.paths) {
        const full = insideProject(cwd, path);
        try {
          const stats = statSync(full);
          if (!stats.isFile()) {
            parts.push(`--- ${path}\n(not a file)`);
            continue;
          }
          if (stats.size > MAX_BYTES) {
            parts.push(
              `--- ${path}\n(${stats.size} bytes, over the ${MAX_BYTES} limit — read it in pieces or use mode "diff")`,
            );
            continue;
          }
          const contents = readFileSync(full, 'utf8');
          if (holdsCredential(contents)) {
            parts.push(`--- ${path}\n(withheld: it contains a private key or a service-account credential)`);
            continue;
          }
          parts.push(`--- ${path}\n${contents}`);
        } catch (error) {
          parts.push(`--- ${path}\n(could not read: ${(error as Error).message})`);
        }
      }
      return textResult(parts.join('\n\n'));
    });
}

/** Split a unified diff by file and drop the files that exist to hold credentials. */
export function withoutSecretFiles(diff: string): { diff: string; withheld: string[] } {
  const withheld: string[] = [];
  const kept = diff
    .split(/^(?=diff --git )/m)
    .filter((chunk) => {
      const header = /^diff --git a\/(.*?) b\/(.*)$/m.exec(chunk);
      if (!header) return true;
      const [, from = '', to = ''] = header;
      if (!isSecretish(from) && !isSecretish(to)) return true;
      withheld.push(to);
      return false;
    });
  return { diff: kept.join(''), withheld };
}

/** Exposed for the test suite, which checks the project name is reported consistently. */
export function projectNameOf(cwd: string): string {
  return loadConfig(cwd).config.project;
}
