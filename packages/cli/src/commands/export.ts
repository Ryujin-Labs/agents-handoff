import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportHandoff, handoffDirectory, HandoffStore, loadConfig } from 'ryujin-handoff-core';
import { boolOption, stringOption, type OptionSpec, type ParsedArgs } from '../args.ts';
import { err, jsonOut, out } from '../ui.ts';

export const exportOptions: Record<string, OptionSpec> = {
  out: { type: 'string', describe: 'Destination .md file or an existing directory', placeholder: '<path>' },
  json: { type: 'boolean', describe: 'Emit the exported path and complete Markdown as JSON' },
};

/** Export the complete stored document without changing its bytes or status. */
export async function exportCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const ref = args.positionals[0];
  if (!ref || args.positionals.length > 1) {
    err('Usage: handoff export <file|id> [--out <path>] [--json]');
    return 1;
  }
  const loaded = loadConfig(cwd);
  const found = new HandoffStore(handoffDirectory(loaded)).resolveRef(ref, cwd);
  if (!found) {
    err(`No handoff matching "${ref}". Pass a stored id or a path to a HANDOFF.md file.`);
    return 1;
  }
  const result = exportHandoff({
    markdown: readFileSync(found.path, 'utf8'),
    sourcePath: found.path,
    cwd,
    exportDir: join(handoffDirectory(loaded), 'exports'),
    ...(stringOption(args, 'out') !== undefined ? { outputPath: stringOption(args, 'out') } : {}),
  });
  if (boolOption(args, 'json')) {
    jsonOut({ id: result.id, path: result.path, source_path: result.sourcePath ?? found.path, markdown: result.markdown, unchanged: result.unchanged });
  } else {
    out(`exported ${result.path}`);
  }
  return 0;
}
