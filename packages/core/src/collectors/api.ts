import { pathsInCategory } from './classify.ts';
import { trulyAdded, trulyRemoved } from './diff.ts';
import type { Collector, CollectorResult, Signal } from './types.ts';
import { emptyResult } from './types.ts';
import { unique } from '../util/text.ts';

interface RoutePattern {
  regex: RegExp;
  /** Index of the capture group holding the HTTP method, when the pattern has one. */
  method: number | null;
  path: number;
  framework: string;
}

/**
 * Route-shaped patterns across the frameworks a handoff is most likely to involve.
 *
 * A missed route costs a line in the brief; a hallucinated one costs trust. Every pattern
 * here requires a literal path string, so the worst failure mode is silence.
 */
const ROUTE_PATTERNS: RoutePattern[] = [
  // Express / Fastify / Hono / Koa router / NestJS raw
  {
    regex: /\b(?:app|router|api|server|route|r)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*[`'"]([^`'"]+)/gi,
    method: 1,
    path: 2,
    framework: 'express-like',
  },
  // NestJS / TS decorators
  {
    regex: /@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(\s*[`'"]?([^`'")]*)/g,
    method: 1,
    path: 2,
    framework: 'decorator',
  },
  // FastAPI / Flask
  {
    regex: /@(?:app|router|api|bp|blueprint)\.(get|post|put|patch|delete)\s*\(\s*[`'"]([^`'"]+)/gi,
    method: 1,
    path: 2,
    framework: 'python',
  },
  // Go net/http and chi/gin/echo
  {
    regex: /\.(?:Handle|HandleFunc|Method)?(GET|POST|PUT|PATCH|DELETE)\s*\(\s*"([^"]+)"/g,
    method: 1,
    path: 2,
    framework: 'go',
  },
  // Rails routes.rb
  {
    regex: /^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)/gim,
    method: 1,
    path: 2,
    framework: 'rails',
  },
  // OpenAPI operation objects: a path key followed by a method key
  { regex: /^\s{2,}(\/[\w{}/.\-:]*)\s*:\s*$/gm, method: null, path: 1, framework: 'openapi' },
];

const GRAPHQL_FIELD = /^\s*(\w+)\s*(\([^)]*\))?\s*:\s*([\w[\]!]+)/;
const PROTO_RPC = /\brpc\s+(\w+)\s*\(([^)]*)\)\s*returns\s*\(([^)]*)\)/;

export const apiCollector: Collector = {
  name: 'api',
  description: 'HTTP routes, GraphQL fields and gRPC methods added or removed.',
  collect(context): CollectorResult {
    const paths = pathsInCategory(context.classification, 'api');
    if (paths.length === 0) return emptyResult('api');

    const signals: Signal[] = [];
    for (const file of context.diffFor(paths)) {
      const added = extractRoutes(trulyAdded(file));
      const removed = extractRoutes(trulyRemoved(file));
      // A route present on both sides had its handler edited, not its existence changed.
      // Reporting that as a removal is the single most misleading thing this collector
      // could do, because it reads as a breaking change when nothing broke.
      const changed = added.filter((route) => removed.includes(route));
      const changedSet = new Set(changed);

      for (const route of changed) {
        signals.push({ kind: 'api', message: `handler changed: ${route}`, file: file.path });
      }
      for (const route of added) {
        if (changedSet.has(route)) continue;
        signals.push({ kind: 'api', message: `added: ${route}`, file: file.path });
      }
      for (const route of removed) {
        if (changedSet.has(route)) continue;
        signals.push({ kind: 'api', message: `removed: ${route}`, file: file.path });
        signals.push({
          kind: 'breaking-candidate',
          message: `route no longer defined: ${route}`,
          file: file.path,
        });
      }
      if (file.path.endsWith('.graphql') || file.path.endsWith('.gql')) {
        signals.push(...graphqlSignals(file.path, trulyAdded(file), trulyRemoved(file)));
      }
      if (file.path.endsWith('.proto')) {
        signals.push(...protoSignals(file.path, trulyAdded(file), trulyRemoved(file)));
      }
    }

    const deduped = dedupe(signals);
    if (deduped.length === 0 && paths.length === 0) return emptyResult('api');

    return {
      name: 'api',
      summary:
        deduped.length > 0
          ? `${deduped.filter((s) => s.kind === 'api').length} route-level change(s) detected across ${paths.length} API file(s).`
          : `${paths.length} API-surface file(s) changed, but no route definitions were added or removed. The change is likely to be in behavior rather than shape.`,
      signals: deduped,
      suggestedReading: paths.slice(0, 12),
      facts: [],
    };
  },
};

function extractRoutes(lines: string[]): string[] {
  const found: string[] = [];
  const text = lines.join('\n');
  for (const pattern of ROUTE_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const routePath = match[pattern.path];
      if (!routePath) continue;
      const method = pattern.method === null ? '' : (match[pattern.method] ?? '').toUpperCase();
      const cleaned = routePath.trim();
      if (!isPlausibleRoutePath(cleaned)) continue;
      found.push(method ? `${method} ${cleaned}` : cleaned);
    }
  }
  return unique(found);
}

/** Reject template literals, regex fragments and other things that are not literal paths. */
function isPlausibleRoutePath(value: string): boolean {
  if (!value || value.length > 120) return false;
  if (/[${}\\]/.test(value) && !/^\/[\w{}/.\-:]*$/.test(value)) return false;
  return value === '/' || value.startsWith('/') || /^[\w\-:./]+$/.test(value);
}

function graphqlSignals(file: string, added: string[], removed: string[]): Signal[] {
  const signals: Signal[] = [];
  for (const line of added) {
    const match = GRAPHQL_FIELD.exec(line);
    if (match) signals.push({ kind: 'contract', message: `GraphQL field added: ${match[1]}: ${match[3]}`, file });
  }
  for (const line of removed) {
    const match = GRAPHQL_FIELD.exec(line);
    if (!match) continue;
    signals.push({ kind: 'contract', message: `GraphQL field removed: ${match[1]}`, file });
    signals.push({ kind: 'breaking-candidate', message: `GraphQL field removed: ${match[1]}`, file });
  }
  return signals;
}

function protoSignals(file: string, added: string[], removed: string[]): Signal[] {
  const signals: Signal[] = [];
  for (const line of added) {
    const match = PROTO_RPC.exec(line);
    if (match) signals.push({ kind: 'api', message: `gRPC method added: ${match[1]}`, file });
  }
  for (const line of removed) {
    const match = PROTO_RPC.exec(line);
    if (!match) continue;
    signals.push({ kind: 'breaking-candidate', message: `gRPC method removed: ${match[1]}`, file });
  }
  return signals;
}

/** Collapse identical (kind, message, file) triples produced by overlapping patterns. */
export function dedupe(signals: Signal[]): Signal[] {
  const seen = new Set<string>();
  const result: Signal[] = [];
  for (const signal of signals) {
    const key = `${signal.kind}::${signal.message}::${signal.file ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(signal);
  }
  return result;
}
