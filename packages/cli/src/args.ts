import { parseArgs, type ParseArgsConfig } from 'node:util';

export type OptionType = 'string' | 'boolean';

export interface OptionSpec {
  type: OptionType;
  short?: string;
  multiple?: boolean;
  /** Shown by `handoff help <command>`. */
  describe: string;
  /** Placeholder for the value, e.g. `<ref>`. */
  placeholder?: string;
}

export interface ParsedArgs {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/**
 * Thin wrapper over `node:util`'s `parseArgs`.
 *
 * A hand-rolled parser over the built-in keeps the CLI dependency-free, which matters for
 * a tool whose pitch includes "boring to install".
 */
export function parse(argv: string[], options: Record<string, OptionSpec>): ParsedArgs {
  const config: ParseArgsConfig = {
    args: argv,
    allowPositionals: true,
    strict: true,
    options: Object.fromEntries(
      Object.entries(options).map(([name, spec]) => [
        name,
        spec.short === undefined
          ? { type: spec.type, multiple: spec.multiple ?? false }
          : { type: spec.type, short: spec.short, multiple: spec.multiple ?? false },
      ]),
    ),
  };

  try {
    const result = parseArgs(config);
    return {
      values: result.values as ParsedArgs['values'],
      positionals: result.positionals as string[],
    };
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

export function stringOption(args: ParsedArgs, name: string): string | undefined {
  const value = args.values[name];
  return typeof value === 'string' ? value : undefined;
}

export function boolOption(args: ParsedArgs, name: string): boolean {
  return args.values[name] === true;
}

export function intOption(args: ParsedArgs, name: string): number | undefined {
  const raw = stringOption(args, name);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(`--${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function listOption(args: ParsedArgs, name: string): string[] {
  const value = args.values[name];
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : [];
}
