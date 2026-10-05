#!/usr/bin/env node
// Regenerate every SKILL.md from the shared method in agents-handoff-core.
// `--check` verifies the committed files are current instead of rewriting them.
//
// Three sets are kept:
// - the Claude Code plugin's `skills/`, which is also what `handoff install claude-code`
//   copies, driving the CLI;
// - this repository's own `.claude/skills/`, which is what a contributor's `/handoff` loads —
//   checking only the first let it fall three revisions of the method behind with CI green;
// - the Codex plugin's `skills/`, driving the MCP tools the plugin ships beside them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSkills } from '../dist/src/generate.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(packageRoot, '..', '..', '..');
const inMonorepo = existsSync(join(repoRoot, 'SPEC.md'));

/** @type {Array<{ base: string, skills: Array<{ name: string, contents: string }> }>} */
const targets = [{ base: join(packageRoot, 'skills'), skills: generateSkills() }];
// Only inside the monorepo; the published package has no repository around it.
if (inMonorepo) {
  targets.push({ base: join(repoRoot, '.claude', 'skills'), skills: generateSkills() });
  const { skillFiles } = await import(join(repoRoot, 'packages', 'mcp', 'dist', 'src', 'prompts.js'));
  targets.push({ base: join(repoRoot, 'packages', 'integrations', 'codex', 'skills'), skills: skillFiles() });
}

const check = process.argv.includes('--check');
let stale = 0;

for (const { base, skills } of targets) {
  for (const skill of skills) {
    const path = join(base, skill.name, 'SKILL.md');
    if (check) {
      let current = '';
      try {
        current = readFileSync(path, 'utf8');
      } catch {
        current = '';
      }
      if (current !== skill.contents) {
        console.error(`stale: ${path}`);
        stale += 1;
      }
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, skill.contents, 'utf8');
    console.log(`wrote ${path}`);
  }
}

if (check && stale > 0) {
  console.error('\nRun: npm run skills');
  process.exit(1);
}
