import { VERSION } from 'ryujin-handoff-core';
import { parse, UsageError, type OptionSpec, type ParsedArgs } from './args.ts';
import { configCommand, configOptions } from './commands/config.ts';
import { contextCommand, contextOptions } from './commands/context.ts';
import { createCommand, createOptions } from './commands/create.ts';
import { initCommand, initOptions } from './commands/init.ts';
import { installCommand, installOptions } from './commands/install.ts';
import {
  listCommand,
  listOptions,
  showCommand,
  showOptions,
  validateCommand,
  validateOptions,
} from './commands/inspect.ts';
import { receiveCommand, receiveOptions } from './commands/receive.ts';
import { exportCommand, exportOptions } from './commands/export.ts';
import { err, heading, out, style } from './ui.ts';
import { canPrompt, detectInteractive, setSession, type Session } from './session.ts';
import { PromptCancelled } from './prompt/index.ts';
import { mainMenu } from './interactive/menu.ts';
import { interactiveCreate } from './interactive/create.ts';
import { interactiveInit } from './interactive/setup.ts';
import { interactiveReceive } from './interactive/transfer.ts';

interface Command {
  name: string;
  summary: string;
  usage: string;
  options: Record<string, OptionSpec>;
  run(args: ParsedArgs, cwd: string): Promise<number>;
  /**
   * Prompt-driven version, used on a terminal when the command was given nothing to work
   * with. Returns null to decline, letting the flag path run as usual.
   */
  interactive?(args: ParsedArgs, cwd: string): Promise<number> | null;
}

const COMMANDS: Command[] = [
  {
    name: 'init',
    summary: 'Set up Agents Handoff in this repository',
    usage: 'handoff init [--project <name>] [--targets <a,b>] [--gitignore] [--claude-code]',
    options: initOptions,
    run: initCommand,
    interactive: (args, cwd) => (hasAnyFlag(args) ? null : interactiveInit(cwd)),
  },
  {
    name: 'context',
    summary: 'Print everything deterministic about the current change',
    usage: 'handoff context [--target <who>] [--base <ref>] [--commits <n>] [--since <when>] [--json]',
    options: contextOptions,
    run: contextCommand,
  },
  {
    name: 'create',
    summary: 'Create a draft handoff from the current change',
    usage: 'handoff create [--target <who>] [--title <text>] [--stdin] [--print]',
    options: createOptions,
    run: createCommand,
    // `--stdin` is how an agent pipes a finished document in; never interrupt that.
    interactive: (args, cwd) =>
      hasAnyFlag(args) ? null : interactiveCreate(cwd),
  },
  {
    name: 'list',
    summary: 'List handoffs in this repository',
    usage: 'handoff list [--inbox] [--all] [--json]',
    options: listOptions,
    run: listCommand,
  },
  {
    name: 'show',
    summary: 'Print one handoff',
    usage: 'handoff show <id|path> [--raw] [--section <title>] [--json]',
    options: showOptions,
    run: showCommand,
  },
  {
    name: 'validate',
    summary: 'Check a handoff against the v1 schema',
    usage: 'handoff validate <id|path> [--strict] [--json]',
    options: validateOptions,
    run: validateCommand,
  },
  {
    name: 'receive',
    summary: 'Read a handoff someone sent you and see what it means here',
    usage: 'handoff receive <path> [--as <target>] [--json]',
    options: receiveOptions,
    run: receiveCommand,
    // Flags mean the caller already decided; asking would drop them on the floor.
    interactive: (args, cwd) =>
      args.positionals.length === 0 && !hasAnyFlag(args) ? interactiveReceive(cwd) : null,
  },
  {
    name: 'export',
    summary: 'Export the complete handoff as a Markdown file',
    usage: 'handoff export <file|id> [--out <path>] [--json]',
    options: exportOptions,
    run: exportCommand,
  },
  {
    name: 'config',
    summary: 'Show or change project configuration',
    usage: 'handoff config [--json] [--collectors] [--set-project <name>]',
    options: configOptions,
    run: configCommand,
  },
  {
    name: 'install',
    summary: 'Connect a coding agent: claude-code (skills), or mcp (Claude Desktop; --print for any other client)',
    usage: 'handoff install <mcp|claude-code> [--user] [--force] [--print]',
    options: installOptions,
    run: installCommand,
  },
];

/** Exit code conventionally used for "interrupted by the user". */
const CANCELLED = 130;

/**
 * @param session Overrides how prompting behaves. Real runs omit it and let the TTY
 *   decide; tests pass one so an interactive flow can be driven without a terminal.
 */
export async function main(argv: string[], cwd: string, session?: Session): Promise<number> {
  // `--no-input` is stripped before per-command parsing so every command accepts it
  // without having to declare it, and so scripts have one switch that always works. It has
  // no short form: `-n` belongs to `--note`, and a global alias silently ate it.
  const noInput = argv.includes('--no-input');
  const args = argv.filter((entry) => entry !== '--no-input');
  setSession(session ?? { interactive: detectInteractive(noInput) });

  const [first, ...rest] = args;

  const deliveryFlags = new Set(['--channel', '--channels', '--route', '--routes', '--to', '--link', '--no-open']);
  if (first === 'send' || (first === 'help' && rest[0] === 'send') || args.some((value) => deliveryFlags.has(value.split('=')[0] ?? value))) {
    err('Agents Handoff only writes Markdown files. Delivery commands and options are no longer supported.');
    err('Use handoff export <file|id> [--out <path>] to get the complete Markdown file.');
    return 1;
  }

  if (first === '--version' || first === '-v' || first === 'version') {
    out(VERSION);
    return 0;
  }
  if (first === '--help' || first === '-h' || first === 'help') {
    return helpCommand(rest);
  }
  // Bare `handoff` opens the menu on a terminal, and prints help everywhere else so a
  // pipe or a CI job still gets something useful instead of hanging on a prompt.
  if (first === undefined) {
    return canPrompt() ? runInteractive(() => mainMenu(cwd)) : helpCommand([]);
  }

  const command = COMMANDS.find((entry) => entry.name === first);
  if (!command) {
    err(`Unknown command "${first}".`);
    err(`Run ${style.cyan('handoff help')} to see what is available.`);
    return 1;
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    printCommandHelp(command);
    return 0;
  }

  try {
    const parsed = parse(rest, command.options);

    if (canPrompt() && command.interactive) {
      const flow = command.interactive(parsed, cwd);
      if (flow !== null) return runInteractive(() => flow);
    }

    return await command.run(parsed, cwd);
  } catch (error) {
    if (error instanceof UsageError) {
      err(`${style.red('error')} ${error.message}`);
      err(`Usage: ${command.usage}`);
      return 1;
    }
    if (error instanceof PromptCancelled) return cancelled();
    err(`${style.red('error')} ${(error as Error).message}`);
    if (process.env['HANDOFF_DEBUG']) err(String((error as Error).stack));
    return 1;
  }
}

/** Run a prompt-driven flow, turning a Ctrl+C into a quiet exit rather than a stack trace. */
async function runInteractive(flow: () => Promise<number>): Promise<number> {
  try {
    return await flow();
  } catch (error) {
    if (error instanceof PromptCancelled) return cancelled();
    throw error;
  }
}

function cancelled(): number {
  out(`\n${style.dim('Cancelled.')}`);
  return CANCELLED;
}

/** True when the user passed anything at all beyond the command name. */
function hasAnyFlag(args: ParsedArgs): boolean {
  return Object.keys(args.values).length > 0 || args.positionals.length > 0;
}

function helpCommand(rest: string[]): number {
  const requested = rest[0];
  if (requested) {
    const command = COMMANDS.find((entry) => entry.name === requested);
    if (!command) {
      err(`Unknown command "${requested}".`);
      return 1;
    }
    printCommandHelp(command);
    return 0;
  }

  out(`${style.bold('handoff')} ${style.dim(VERSION)} — structured software-change handoffs between developers and their coding agents.`);
  out();
  heading('Usage');
  out('  handoff <command> [options]');
  out();
  heading('Commands');
  for (const command of COMMANDS) {
    out(`  ${command.name.padEnd(10)} ${command.summary}`);
  }
  out();
  heading('The loop');
  out('  1. finish a change');
  out(`  2. ${style.cyan('/handoff mobile')} in your coding agent, or ${style.cyan('handoff create --target mobile')}`);
  out(`  3. ${style.cyan('handoff export <id>')} writes the complete Markdown file`);
  out(`  4. they run ${style.cyan('/handoff-receive <file>')} and their agent knows what to build`);
  out();
  out(style.dim('handoff help <command> for details on one command.'));
  return 0;
}

function printCommandHelp(command: Command): void {
  out(`${style.bold(command.name)} — ${command.summary}`);
  out();
  out(`  ${command.usage}`);
  const entries = Object.entries(command.options);
  if (entries.length > 0) {
    out();
    heading('Options');
    for (const [name, spec] of entries) {
      const short = spec.short ? `-${spec.short}, ` : '    ';
      const placeholder = spec.placeholder ? ` ${spec.placeholder}` : '';
      out(`  ${short}--${name}${placeholder}`.padEnd(34) + spec.describe);
    }
  }
}
