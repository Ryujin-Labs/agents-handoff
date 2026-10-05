import type { HandoffSection } from '../types.ts';
import { normalizeHeading } from '../util/text.ts';

export interface BodyStructure {
  /** Text of the single H1, or null when the body has none. */
  title: string | null;
  /** Number of H1 headings found. More than one is a validation error. */
  h1Count: number;
  /** Content between the H1 and the first `##`. */
  preamble: string;
  sections: HandoffSection[];
}

const FENCE = /^(\s*)(`{3,}|~{3,})/;

/**
 * Split a Markdown body into `##` sections.
 *
 * Fenced code blocks are tracked so that a `## comment` inside a shell snippet is not
 * mistaken for a section heading.
 */
export function parseBody(body: string): BodyStructure {
  const lines = body.replace(/\r\n/g, '\n').split('\n');

  let title: string | null = null;
  let h1Count = 0;
  const preambleLines: string[] = [];
  const sections: HandoffSection[] = [];
  let current: { title: string; lines: string[] } | null = null;

  let fence: string | null = null;

  for (const line of lines) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[2] ?? '';
      if (fence === null) {
        fence = marker[0] === '`' ? '`' : '~';
      } else if (marker[0] === fence) {
        fence = null;
      }
    }

    if (fence === null) {
      const h1 = /^#[ \t]+(.*\S)[ \t]*$/.exec(line);
      if (h1) {
        h1Count++;
        if (title === null) title = h1[1] ?? '';
        continue;
      }
      const h2 = /^##[ \t]+(.*\S)[ \t]*$/.exec(line);
      if (h2) {
        if (current) sections.push({ title: current.title, content: trimBlank(current.lines) });
        current = { title: h2[1] ?? '', lines: [] };
        continue;
      }
    }

    if (current) current.lines.push(line);
    else preambleLines.push(line);
  }

  if (current) sections.push({ title: current.title, content: trimBlank(current.lines) });

  return { title, h1Count, preamble: trimBlank(preambleLines), sections };
}

function trimBlank(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim() === '') start++;
  while (end > start && (lines[end - 1] ?? '').trim() === '') end--;
  return lines.slice(start, end).join('\n');
}

/** Look up a section by heading text, case- and whitespace-insensitively. */
export function findSection(
  sections: readonly HandoffSection[],
  title: string,
): HandoffSection | undefined {
  const wanted = normalizeHeading(title);
  return sections.find((section) => normalizeHeading(section.title) === wanted);
}

/** True when the section exists and has at least one non-blank line. */
export function hasContent(sections: readonly HandoffSection[], title: string): boolean {
  const section = findSection(sections, title);
  return Boolean(section && section.content.trim().length > 0);
}

export interface CodeBlock {
  language: string;
  content: string;
  lineCount: number;
}

/** Extract fenced code blocks from a Markdown string. */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let open: { language: string; marker: string; lines: string[] } | null = null;

  for (const line of lines) {
    const match = FENCE.exec(line);
    if (match) {
      const marker = match[2] ?? '';
      if (open === null) {
        open = { language: line.slice(match[0].length).trim(), marker: marker[0] ?? '`', lines: [] };
        continue;
      }
      if ((marker[0] ?? '') === open.marker) {
        blocks.push({
          language: open.language,
          content: open.lines.join('\n'),
          lineCount: open.lines.length,
        });
        open = null;
        continue;
      }
    }
    if (open) open.lines.push(line);
  }

  if (open) {
    blocks.push({ language: open.language, content: open.lines.join('\n'), lineCount: open.lines.length });
  }
  return blocks;
}
