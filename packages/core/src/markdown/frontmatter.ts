import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface SplitDocument {
  /** Raw YAML text between the fences, or null when there is no frontmatter block. */
  yaml: string | null;
  /** Everything after the closing fence. */
  body: string;
  /** 1-based line number of the first body line, for error reporting. */
  bodyStartLine: number;
}

const OPEN_FENCE = /^---[ \t]*$/;
const CLOSE_FENCE = /^(?:---|\.\.\.)[ \t]*$/;

/**
 * Split a document into its YAML frontmatter and Markdown body.
 *
 * The opening fence must be the very first line (a leading BOM is tolerated). This is
 * deliberately strict: a `---` further down a document is a horizontal rule, not
 * frontmatter.
 */
export function splitFrontmatter(source: string): SplitDocument {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const first = lines[0];
  if (first === undefined || !OPEN_FENCE.test(first)) {
    return { yaml: null, body: text, bodyStartLine: 1 };
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && CLOSE_FENCE.test(line)) {
      return {
        yaml: lines.slice(1, i).join('\n'),
        body: lines.slice(i + 1).join('\n'),
        bodyStartLine: i + 2,
      };
    }
  }
  // An opening fence with no closing fence is a malformed document, not a body.
  return { yaml: null, body: text, bodyStartLine: 1 };
}

export class FrontmatterParseError extends Error {
  override readonly name = 'FrontmatterParseError';
}

export function parseFrontmatterYaml(yaml: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml, { prettyErrors: true });
  } catch (error) {
    throw new FrontmatterParseError(`frontmatter is not valid YAML: ${(error as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FrontmatterParseError('frontmatter must be a YAML mapping');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Serialize frontmatter to YAML with stable key order and no line wrapping.
 * Wrapping is disabled because a wrapped URL or commit message is painful to read and
 * breaks naive greps.
 */
export function stringifyFrontmatterYaml(value: Record<string, unknown>): string {
  return stringifyYaml(value, { lineWidth: 0, nullStr: 'null', singleQuote: false }).trimEnd();
}
