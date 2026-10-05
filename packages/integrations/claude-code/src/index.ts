import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRootOf } from 'agents-handoff-core';

/**
 * Claude Code integration for Agents Handoff.
 *
 * Everything here uses officially supported extension points only: a plugin manifest at
 * `.claude-plugin/plugin.json`, the MCP server in `.mcp.json`, and skills at
 * `skills/<name>/SKILL.md`, which Claude Code exposes as `/agents-handoff:<name>` from the
 * plugin and as `/<name>` when copied into a project by `handoff install claude-code`.
 *
 * There is deliberately no attempt to read Claude Code's conversation transcript. No
 * supported API exposes it, and anything that scraped it would break on the next release.
 * The skill instead asks the agent to contribute what it already remembers, which is both
 * more reliable and available in every agent, not just this one.
 */

export interface SkillFile {
  /** Skill name, which is also the slash command: `handoff` -> `/handoff`. */
  name: string;
  /** Absolute path to the source `SKILL.md`. */
  path: string;
  contents: string;
}

/** Root of the installed `agents-handoff-claude-code` package. */
export function packageRoot(): string {
  return packageRootOf(import.meta.url);
}

export function skillsDir(): string {
  return join(packageRoot(), 'skills');
}

export function pluginManifestPath(): string {
  return join(packageRoot(), '.claude-plugin', 'plugin.json');
}

/** Read every bundled skill. Used by `handoff install claude-code`. */
export function readSkills(): SkillFile[] {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  const skills: SkillFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name, 'SKILL.md');
    if (!existsSync(path)) continue;
    skills.push({ name, path, contents: readFileSync(path, 'utf8') });
  }
  return skills;
}

export const PLUGIN_NAME = 'agents-handoff';
export const SKILL_NAMES = ['handoff', 'handoff-receive'] as const;

export { generateSkills } from './generate.ts';
export type { GeneratedSkill } from './generate.ts';
