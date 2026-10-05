import { pathsInCategory } from './classify.ts';
import { trulyAdded, trulyRemoved } from './diff.ts';
import type { Collector, CollectorResult, Signal } from './types.ts';
import { emptyResult } from './types.ts';

/** `"name": "^1.2.3"` (npm), `name==1.2.3` (pip), `name = "1.2"` (cargo), `name v1.2.3` (go). */
const SPECS: RegExp[] = [
  /^\s*["']([@\w][\w@/.\-]*)["']\s*:\s*["']([^"']+)["']/,
  /^\s*([A-Za-z][\w.\-]*)\s*(?:==|>=|~=)\s*([\w.*\-]+)/,
  /^\s*([A-Za-z][\w.\-]*)\s*=\s*["']([^"']+)["']/,
  /^\s*(?:require\s+)?([\w.\-]+\/[\w.\-/]+)\s+v?([\w.\-+]+)/,
  /^\s*gem\s+['"]([\w.\-]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/,
];

/**
 * Lockfiles are excluded on purpose: they change constantly, say nothing a consumer must
 * act on, and would drown the brief.
 */
const LOCKFILE = /(lock|\.sum)$/i;

export const dependencyCollector: Collector = {
  name: 'dependencies',
  description: 'Packages added, removed or version-bumped in manifest files.',
  collect(context): CollectorResult {
    const paths = pathsInCategory(context.classification, 'dependency').filter(
      (path) => !LOCKFILE.test(path),
    );
    if (paths.length === 0) return emptyResult('dependencies');

    const signals: Signal[] = [];
    for (const file of context.diffFor(paths)) {
      const before = toMap(trulyRemoved(file));
      const after = toMap(trulyAdded(file));

      for (const [name, version] of after) {
        const previous = before.get(name);
        if (previous === undefined) {
          signals.push({ kind: 'dependency', message: `added ${name}@${version}`, file: file.path });
        } else if (previous !== version) {
          signals.push({
            kind: 'dependency',
            message: `${name} ${previous} -> ${version}`,
            file: file.path,
          });
        }
      }
      for (const [name, version] of before) {
        if (!after.has(name)) {
          signals.push({ kind: 'dependency', message: `removed ${name}@${version}`, file: file.path });
        }
      }
    }

    if (signals.length === 0) return emptyResult('dependencies');
    return {
      name: 'dependencies',
      summary: `${signals.length} dependency change(s). Relevant to a consumer only if they share the package or the runtime.`,
      signals: signals.slice(0, 30),
      suggestedReading: [],
      facts: [],
    };
  },
};

function toMap(lines: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of lines) {
    // Skip manifest metadata that happens to look like a dependency entry.
    if (/^\s*["'](name|version|description|license|main|type|private)["']\s*:/.test(line)) continue;
    for (const spec of SPECS) {
      const match = spec.exec(line);
      if (match?.[1]) {
        map.set(match[1], match[2] ?? '');
        break;
      }
    }
  }
  return map;
}
