import { pathsInCategory } from './classify.ts';
import { trulyAdded, trulyRemoved } from './diff.ts';
import { dedupe } from './api.ts';
import type { Collector, CollectorResult, Signal } from './types.ts';
import { emptyResult } from './types.ts';
import { truncate } from '../util/text.ts';

/** A fragment that declares a named member of a type, interface, struct or schema. */
const MEMBER_DECLARATION =
  /^\s*(?:readonly\s+|public\s+|private\s+|export\s+)?["']?([A-Za-z_$][\w$]*)["']?\s*(\??)\s*[:=]\s*(.+?)[,;]?\s*$/;

/** Words that look like members but are language syntax rather than data fields. */
const NOT_A_FIELD = new Set([
  'if', 'for', 'while', 'switch', 'case', 'return', 'const', 'let', 'var', 'import',
  'export', 'default', 'type', 'interface', 'class', 'enum', 'function', 'async', 'await',
  'else', 'try', 'catch', 'finally', 'new', 'this', 'super', 'from', 'as', 'in', 'of',
]);
const TYPE_DECLARATION = /\b(?:interface|type|class|struct|enum|message|model)\s+([A-Z]\w*)/;
const REQUIRED_MARKERS = /\b(?:required|NOT NULL|nonnull|@NonNull|\.min\(|z\.string\(\)(?!\.optional))/i;

/**
 * Detect changes to the *shape* of data crossing a boundary.
 *
 * A removed field and a newly-required field are the two most common ways a change breaks
 * a client that was never touched, so both are raised as breaking candidates.
 */
export const contractCollector: Collector = {
  name: 'contracts',
  description: 'Types, DTOs, schemas: fields added, removed or newly required.',
  collect(context): CollectorResult {
    const paths = pathsInCategory(context.classification, 'contract');
    if (paths.length === 0) return emptyResult('contracts');

    const signals: Signal[] = [];
    for (const file of context.diffFor(paths)) {
      const added = trulyAdded(file);
      const removed = trulyRemoved(file);

      const addedNames = new Set(added.flatMap((line) => memberNames(line)));
      const removedNames = new Set(removed.flatMap((line) => memberNames(line)));

      for (const line of added) {
        const type = TYPE_DECLARATION.exec(line);
        if (type) {
          signals.push({ kind: 'contract', message: `type declared: ${type[1]}`, file: file.path });
        }
        for (const name of memberNames(line)) {
          if (removedNames.has(name)) continue;
          const optional = isOptional(line, name);
          signals.push({
            kind: 'contract',
            message: `field added: ${name}${optional ? ' (optional)' : ''}`,
            file: file.path,
            evidence: truncate(line.trim(), 140),
          });
          if (!optional && REQUIRED_MARKERS.test(line)) {
            signals.push({
              kind: 'breaking-candidate',
              message: `field "${name}" appears newly required`,
              file: file.path,
              evidence: truncate(line.trim(), 140),
            });
          }
        }
      }

      for (const line of removed) {
        for (const name of memberNames(line)) {
          // A field that reappears in the added lines was retyped, not removed.
          if (addedNames.has(name)) continue;
          signals.push({
            kind: 'breaking-candidate',
            message: `field removed: ${name}`,
            file: file.path,
            evidence: truncate(line.trim(), 140),
          });
        }
      }
    }

    const deduped = dedupe(signals).slice(0, 40);
    if (deduped.length === 0 && paths.length === 0) return emptyResult('contracts');
    return {
      name: 'contracts',
      summary:
        deduped.length > 0
          ? `${deduped.length} contract-level change(s) across ${paths.length} file(s).`
          : `${paths.length} type/schema file(s) changed without recognizable field-level edits.`,
      signals: deduped,
      suggestedReading: paths.slice(0, 12),
      facts: [],
    };
  },
};

/**
 * Field names declared anywhere on a line.
 *
 * Types are frequently written on one line — `interface Message { id: string; body: string }`
 * — so splitting on separators before matching is what makes field-level detection work on
 * real code rather than only on prettily formatted code.
 */
export function memberNames(line: string): string[] {
  const inner = /\{(.+)\}/.exec(line);
  const fragments = inner?.[1] ? inner[1].split(/[;,]/) : [line];
  const names: string[] = [];
  for (const fragment of fragments) {
    const match = MEMBER_DECLARATION.exec(fragment);
    const name = match?.[1];
    if (!name || NOT_A_FIELD.has(name)) continue;
    // Reject `foo: () => {` and other code shapes that are not data declarations.
    if (/^\s*(?:=>|function\b)/.test(match?.[3] ?? '')) continue;
    names.push(name);
  }
  return [...new Set(names)];
}

function isOptional(line: string, name: string): boolean {
  return new RegExp(`\\b${name}\\?\\s*:`).test(line) || /\boptional\b|\.optional\(\)/.test(line);
}
