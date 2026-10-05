import { agentContextCollector } from './agent-context.ts';
import { apiCollector } from './api.ts';
import { authCollector } from './auth.ts';
import { contractCollector } from './contracts.ts';
import { databaseCollector } from './database.ts';
import { dependencyCollector } from './dependencies.ts';
import { environmentCollector } from './environment.ts';
import { gitCollector } from './git.ts';
import { infrastructureCollector } from './infrastructure.ts';
import { testCollector } from './tests.ts';
import type { Collector } from './types.ts';

/**
 * The built-in collectors, in the order their output appears in a brief.
 *
 * This array is the extension point: a future plugin system registers into the same list,
 * and nothing downstream needs to know where a collector came from.
 */
export const BUILTIN_COLLECTORS: readonly Collector[] = [
  gitCollector,
  apiCollector,
  authCollector,
  contractCollector,
  databaseCollector,
  environmentCollector,
  dependencyCollector,
  infrastructureCollector,
  testCollector,
  agentContextCollector,
];

export function collectorsFor(disabled: readonly string[]): Collector[] {
  const skip = new Set(disabled);
  return BUILTIN_COLLECTORS.filter((collector) => !skip.has(collector.name));
}

export * from './types.ts';
export * from './classify.ts';
export * from './diff.ts';
export { detectTestCommand } from './tests.ts';
