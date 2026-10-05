import { trulyAdded, trulyRemoved } from './diff.ts';
import type { Collector, CollectorResult, Signal } from './types.ts';
import { emptyResult } from './types.ts';
import { unique } from '../util/text.ts';

/**
 * Ways a codebase reads an environment variable, across the languages a polyglot team is
 * likely to have. Scanning the whole diff rather than only `.env` files is deliberate: the
 * `.env.example` update is exactly the step people forget.
 */
const READERS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
  /Deno\.env\.get\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  /os\.environ(?:\.get)?[[(]\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  /os\.[Gg]etenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  /System\.getenv\(\s*"([A-Z][A-Z0-9_]*)"/g,
  /ENV\[\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  /env!\(\s*"([A-Z][A-Z0-9_]*)"/g,
  /^\s*([A-Z][A-Z0-9_]*)\s*=/gm,
];

/** Names that are environment-shaped but never interesting in a handoff. */
const IGNORED = new Set(['NODE_ENV', 'PATH', 'HOME', 'PWD', 'CI', 'DEBUG', 'TZ', 'LANG']);

export const environmentCollector: Collector = {
  name: 'environment',
  description: 'Environment variables newly read or no longer read.',
  collect(context): CollectorResult {
    const paths = [...context.classification.keys()].filter(
      (path) => !context.classification.get(path)?.includes('generated'),
    );
    if (paths.length === 0) return emptyResult('environment');

    const added = new Set<string>();
    const removed = new Set<string>();
    const sources = new Map<string, string>();

    for (const file of context.diffFor(paths)) {
      for (const name of extractNames(trulyAdded(file))) {
        added.add(name);
        if (!sources.has(name)) sources.set(name, file.path);
      }
      for (const name of extractNames(trulyRemoved(file))) removed.add(name);
    }

    const newVars = [...added].filter((name) => !removed.has(name)).sort();
    const goneVars = [...removed].filter((name) => !added.has(name)).sort();
    if (newVars.length === 0 && goneVars.length === 0) return emptyResult('environment');

    const signals: Signal[] = [
      ...newVars.map((name): Signal => {
        const file = sources.get(name);
        return file
          ? { kind: 'environment', message: `new environment variable: ${name}`, file }
          : { kind: 'environment', message: `new environment variable: ${name}` };
      }),
      ...goneVars.map((name): Signal => ({
        kind: 'environment',
        message: `environment variable no longer read: ${name}`,
      })),
    ];

    return {
      name: 'environment',
      summary: `${newVars.length} new and ${goneVars.length} removed environment variable(s). Deployment configuration may need updating before this ships.`,
      signals,
      suggestedReading: [],
      facts: newVars.length > 0 ? [{ label: 'new variables', value: newVars.join(', ') }] : [],
    };
  },
};

function extractNames(lines: string[]): string[] {
  const text = lines.join('\n');
  const names: string[] = [];
  for (const reader of READERS) {
    const regex = new RegExp(reader.source, reader.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const name = match[1];
      if (name && name.length > 2 && !IGNORED.has(name)) names.push(name);
    }
  }
  return unique(names);
}
