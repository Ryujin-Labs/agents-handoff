import { join, relative } from 'node:path';
import { handoffDirectory, loadConfig } from 'ryujin-handoff-core';
import { text } from '../prompt/index.ts';
import { out, style } from '../ui.ts';
import { exportCommand } from '../commands/export.ts';
import { pickHandoff } from './pick.ts';

/** Select a handoff and a local Markdown destination. */
export async function interactiveExport(cwd: string): Promise<number> {
  const entry = await pickHandoff(cwd, 'all', 'Which handoff do you want to export?');
  if (!entry) {
    out(style.dim('No handoffs here yet.'));
    return 0;
  }
  const destination = await text({
    message: 'Export the Markdown file where?',
    default: relative(cwd, join(handoffDirectory(loadConfig(cwd)), 'exports', `${entry.id}.md`)),
    validate: (value) => (value.trim() ? null : 'give it a path'),
  });
  return exportCommand({ values: { out: destination }, positionals: [entry.id] }, cwd);
}
