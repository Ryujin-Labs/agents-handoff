import { pathsInCategory } from './classify.ts';
import type { Collector, CollectorResult, Signal } from './types.ts';
import { emptyResult } from './types.ts';

/**
 * Deployment- and configuration-shaped changes. These rarely require application work from
 * a consumer, which is itself worth saying: "no action required" is a valid and useful
 * Required Actions entry for a devops-adjacent change.
 */
export const infrastructureCollector: Collector = {
  name: 'infrastructure',
  description: 'Deployment, CI and configuration files that changed.',
  collect(context): CollectorResult {
    const infra = pathsInCategory(context.classification, 'infrastructure');
    const config = pathsInCategory(context.classification, 'config');
    const paths = [...new Set([...infra, ...config])];
    if (paths.length === 0) return emptyResult('infrastructure');

    const signals: Signal[] = paths.slice(0, 20).map((path) => ({
      kind: infra.includes(path) ? 'infrastructure' : 'config',
      message: `changed: ${path}`,
      file: path,
    }));

    return {
      name: 'infrastructure',
      summary: `${paths.length} infrastructure/config file(s) changed.`,
      signals,
      suggestedReading: paths.slice(0, 8),
      facts: [],
    };
  },
};
