import { unique } from './util/text.ts';

/**
 * Common consumer aliases, normalized to a canonical label. The vocabulary is open — an
 * unknown target passes through unchanged, lowercased. Aliases exist so `/handoff fe` and
 * `/handoff frontend` do not produce two different-looking handoffs.
 */
const ALIASES: Record<string, string> = {
  fe: 'frontend',
  ui: 'frontend',
  client: 'frontend',
  web: 'web',
  webapp: 'web',
  be: 'backend',
  api: 'backend',
  server: 'backend',
  ios: 'ios',
  android: 'android',
  app: 'mobile',
  rn: 'mobile',
  flutter: 'mobile',
  infra: 'devops',
  ops: 'devops',
  sre: 'devops',
  platform: 'devops',
  data: 'data',
  analytics: 'data',
  ml: 'data',
  qa: 'qa',
  test: 'qa',
  docs: 'docs',
  sdk: 'sdk',
};

/** Targets suggested during `handoff init` when we cannot infer better ones. */
export const SUGGESTED_TARGETS = [
  'backend',
  'web',
  'frontend',
  'mobile',
  'ios',
  'android',
  'sdk',
  'devops',
  'data',
  'qa',
  'docs',
];

export function normalizeTarget(input: string): string {
  const key = input.trim().toLowerCase();
  return ALIASES[key] ?? key;
}

/**
 * Parse a target argument. Accepts `mobile`, `mobile,web`, and `mobile web`, because all
 * three are things a developer will type.
 */
export function parseTargets(input: string | undefined | null): string[] {
  if (!input) return [];
  return unique(
    input
      .split(/[\s,]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map(normalizeTarget),
  );
}
