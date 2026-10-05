import { pathsInCategory } from './classify.ts';
import { trulyAdded } from './diff.ts';
import { dedupe } from './api.ts';
import type { Collector, CollectorResult, Signal } from './types.ts';
import { emptyResult } from './types.ts';
import { truncate } from '../util/text.ts';

/**
 * Schema operations, ordered so that destructive ones are recognized first. A dropped
 * column is a contract change even when no application code near it moved.
 */
const OPERATIONS: Array<{ regex: RegExp; message: (m: RegExpExecArray) => string; breaking: boolean }> = [
  { regex: /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`']?(\w+)/i, message: (m) => `table dropped: ${m[1]}`, breaking: true },
  { regex: /\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?["`']?(\w+)/i, message: (m) => `column dropped: ${m[1]}`, breaking: true },
  { regex: /\bALTER\s+COLUMN\s+["`']?(\w+)["`']?[^\n]*\bSET\s+NOT\s+NULL/i, message: (m) => `column made NOT NULL: ${m[1]}`, breaking: true },
  { regex: /\bRENAME\s+(?:COLUMN\s+)?["`']?(\w+)["`']?\s+TO\s+["`']?(\w+)/i, message: (m) => `renamed ${m[1]} to ${m[2]}`, breaking: true },
  { regex: /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["`']?(\w+)/i, message: (m) => `column added: ${m[1]}`, breaking: false },
  { regex: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`']?(\w+)/i, message: (m) => `table created: ${m[1]}`, breaking: false },
  { regex: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?["`']?(\w+)/i, message: (m) => `index created: ${m[1]}`, breaking: false },
  { regex: /\bremoveColumn\s*\(\s*['"](\w+)['"]\s*,\s*['"](\w+)/, message: (m) => `column removed: ${m[1]}.${m[2]}`, breaking: true },
  { regex: /\bdrop_column\s+:(\w+)\s*,\s*:(\w+)/, message: (m) => `column removed: ${m[1]}.${m[2]}`, breaking: true },
  { regex: /\bop\.drop_column\s*\(\s*['"](\w+)['"]\s*,\s*['"](\w+)/, message: (m) => `column removed: ${m[1]}.${m[2]}`, breaking: true },
];

export const databaseCollector: Collector = {
  name: 'database',
  description: 'Migrations and schema files: destructive and additive operations.',
  collect(context): CollectorResult {
    const paths = pathsInCategory(context.classification, 'database');
    if (paths.length === 0) return emptyResult('database');

    const signals: Signal[] = [];
    const migrations = paths.filter((path) => /migrat/i.test(path));

    for (const file of context.diffFor(paths)) {
      for (const line of trulyAdded(file)) {
        for (const operation of OPERATIONS) {
          const match = operation.regex.exec(line);
          if (!match) continue;
          signals.push({
            kind: 'database',
            message: operation.message(match),
            file: file.path,
            evidence: truncate(line.trim(), 140),
          });
          if (operation.breaking) {
            signals.push({
              kind: 'breaking-candidate',
              message: `destructive schema change: ${operation.message(match)}`,
              file: file.path,
            });
          }
          break;
        }
      }
    }

    const deduped = dedupe(signals);
    const facts: Array<{ label: string; value: string }> = [];
    if (migrations.length > 0) {
      facts.push({ label: 'migrations touched', value: migrations.join('\n') });
    }

    return {
      name: 'database',
      summary:
        migrations.length > 0
          ? `${migrations.length} migration file(s) changed. Deployment ordering may matter for consumers.`
          : `${paths.length} database file(s) changed.`,
      signals: deduped,
      suggestedReading: paths.slice(0, 10),
      facts,
    };
  },
};
