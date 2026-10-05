import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { readSkills } from 'agents-handoff-claude-code';
import { Git, readJsonIfExists } from 'agents-handoff-core';
import { boolOption, type OptionSpec, type ParsedArgs } from '../args.ts';
import { displayPath, err, heading, out, style } from '../ui.ts';

export const installOptions: Record<string, OptionSpec> = {
  force: { type: 'boolean', describe: 'Overwrite an existing entry that differs' },
  user: { type: 'boolean', describe: 'Install for yourself rather than into this project' },
  print: { type: 'boolean', describe: 'Print the config instead of writing it' },
};

export interface InstallResult {
  ok: boolean;
  messages: string[];
}

/** The MCP entry every client needs, written once so the three install paths agree. */
export function mcpServerEntry(): { command: string; args: string[] } {
  // `npx -y` means a developer never installs anything globally: the client fetches the
  // server on first use and keeps it cached. That is the whole point of this path.
  return { command: 'npx', args: ['-y', 'agents-handoff-mcp'] };
}

/**
 * Copy the bundled skills into `.claude/skills/`.
 *
 * There are two supported ways to get these into Claude Code: install the plugin from the
 * marketplace, or drop the skill files into the project. This is the second, and it exists
 * because it needs no marketplace, no network, and it puts the skills in the repository
 * where a whole team picks them up by cloning.
 */
export function installClaudeCode(
  root: string,
  options: { force?: boolean; userScope?: boolean } = {},
): InstallResult {
  const base = options.userScope
    ? join(homedir(), '.claude', 'skills')
    : join(root, '.claude', 'skills');

  const skills = readSkills();
  if (skills.length === 0) {
    return {
      ok: false,
      messages: [`${style.red('error')} no bundled skills found; is agents-handoff-claude-code installed?`],
    };
  }

  const messages: string[] = [];
  for (const skill of skills) {
    const dir = join(base, skill.name);
    const target = join(dir, 'SKILL.md');
    if (existsSync(target) && !options.force) {
      const existing = readFileSync(target, 'utf8');
      if (existing === skill.contents) {
        messages.push(`${style.dim('unchanged')} /${skill.name}`);
      } else {
        messages.push(
          `${style.yellow('skipped')}   /${skill.name} (already exists and differs; re-run with --force)`,
        );
      }
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, skill.contents, 'utf8');
    messages.push(`${style.green('installed')} /${skill.name} -> ${target}`);
  }

  return { ok: true, messages };
}

interface McpConfigFile {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Where Claude Desktop keeps its MCP configuration on each platform. */
export function claudeDesktopConfigPath(): string | null {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32': {
      const appData = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
      return join(appData, 'Claude', 'claude_desktop_config.json');
    }
    case 'linux':
      return join(home, '.config', 'Claude', 'claude_desktop_config.json');
    default:
      return null;
  }
}

/**
 * Add the server to an MCP config file, preserving everything else in it.
 *
 * The file belongs to the client, not to us: it may hold other servers a developer
 * depends on, so it is read, merged and rewritten rather than replaced.
 */
export function addMcpServer(
  path: string,
  options: { force?: boolean } = {},
): { ok: boolean; changed: boolean; message: string } {
  const existing = readJsonIfExists<McpConfigFile>(path) ?? {};
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  const entry = mcpServerEntry();

  const current = servers['agents-handoff'];
  if (current !== undefined && !options.force) {
    const same = JSON.stringify(current) === JSON.stringify(entry);
    return {
      ok: true,
      changed: false,
      message: same
        ? `${style.dim('unchanged')} agents-handoff is already configured`
        : `${style.yellow('skipped')}   agents-handoff is configured differently; re-run with --force`,
    };
  }

  servers['agents-handoff'] = entry;
  existing.mcpServers = servers;
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  return { ok: true, changed: true, message: `${style.green('added')}     agents-handoff` };
}

export async function installCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const what = args.positionals[0] ?? 'claude-code';
  const force = boolOption(args, 'force');
  const root = new Git(cwd).root() ?? cwd;

  if (what === 'claude-code') {
    const userScope = boolOption(args, 'user');
    const result = installClaudeCode(root, { force, userScope });
    heading(userScope ? 'Claude Code skills (user scope)' : 'Claude Code skills (this project)');
    for (const message of result.messages) out(`  ${message}`);
    if (!result.ok) return 1;
    out();
    out(`Restart Claude Code, then run ${style.cyan('/handoff')} in this repository.`);
    return 0;
  }

  if (what === 'mcp' || what === 'claude-desktop') {
    return installMcp(args, cwd);
  }

  err(`Unknown integration "${what}". Available: claude-code, mcp, claude-desktop`);
  return 1;
}

/** Wire the MCP server into Claude Desktop, or print the entry for any other client. */
function installMcp(args: ParsedArgs, cwd: string): number {
  const entry = mcpServerEntry();
  const snippet = JSON.stringify({ mcpServers: { 'agents-handoff': entry } }, null, 2);

  if (boolOption(args, 'print')) {
    out(snippet);
    return 0;
  }

  const path = claudeDesktopConfigPath();
  if (!path) {
    err(`No Claude Desktop config location is known for this platform.`);
    err(`Add this to your MCP client's configuration yourself:\n\n${snippet}`);
    return 1;
  }

  // Only where Claude Desktop already keeps its settings: creating its directory from
  // scratch would "install" into an app that is not there, and say it worked.
  if (!existsSync(dirname(path))) {
    err(`Claude Desktop does not seem to be installed here (no ${displayPath(dirname(path), cwd)}). Nothing was written.`);
    err(`For Claude Code: claude mcp add agents-handoff -- npx -y agents-handoff-mcp`);
    err(`For any other MCP client, add this to its configuration:\n\n${snippet}`);
    return 1;
  }

  heading('Claude Desktop');
  const result = addMcpServer(path, { force: boolOption(args, 'force') });
  out(`  ${result.message}`);
  out(`  ${style.dim(displayPath(path, cwd))}`);
  out();
  out(`Restart Claude Desktop. Your agent then has the handoff tools, and ${style.cyan('/handoff')}`);
  out('appears as a prompt — no terminal, and nothing installed globally.');
  out();
  out(style.dim('For Claude Code instead: claude mcp add agents-handoff -- npx -y agents-handoff-mcp'));
  out(style.dim('For any other MCP client: handoff install mcp --print'));
  return result.ok ? 0 : 1;
}
