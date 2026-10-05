/** Count words the way a reader would: runs of non-whitespace. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** Normalize a heading for case-insensitive comparison. */
export function normalizeHeading(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Collapse 3+ consecutive blank lines into one, and ensure a single trailing newline. */
export function tidyMarkdown(text: string): string {
  return `${text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((line) => (line ? prefix + line : line))
    .join('\n');
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Render a Markdown table. Cells are escaped so pipes cannot break the layout. */
export function markdownTable(headers: string[], rows: string[][]): string {
  const escape = (cell: string): string => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `| ${headers.map(escape).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escape).join(' | ')} |`),
  ];
  return lines.join('\n');
}

/** Deduplicate while preserving first-seen order. */
export function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}
