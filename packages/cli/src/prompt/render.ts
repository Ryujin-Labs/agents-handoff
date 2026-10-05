import type { Writable } from 'node:stream';

/**
 * The subset of terminal control the prompts need.
 *
 * Written out by hand rather than pulled from a dependency: it is a dozen escape
 * sequences, and a tool whose pitch includes "boring to install" should not add a
 * dependency tree to draw a list.
 */
const CSI = '\u001b[';

export const ansi = {
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  clearLine: `${CSI}2K`,
  lineStart: `${CSI}G`,
  up: (n: number) => (n > 0 ? `${CSI}${n}A` : ''),
  down: (n: number) => (n > 0 ? `${CSI}${n}B` : ''),
};

export class Renderer {
  /** Lines written by the last render, so the next one knows what to erase. */
  private height = 0;

  constructor(private readonly output: Writable) {}

  write(text: string): void {
    this.output.write(text);
  }

  hideCursor(): void {
    this.write(ansi.hideCursor);
  }

  showCursor(): void {
    this.write(ansi.showCursor);
  }

  /** Replace whatever was drawn last with `lines`. */
  render(lines: string[]): void {
    this.erase();
    this.write(lines.join('\n'));
    this.write('\n');
    this.height = lines.length + 1;
  }

  /** Erase the current render, leaving the cursor where it started. */
  erase(): void {
    if (this.height === 0) return;
    for (let i = 0; i < this.height; i++) {
      this.write(ansi.clearLine + ansi.lineStart);
      if (i < this.height - 1) this.write(ansi.up(1));
    }
    this.height = 0;
  }

  /** Erase the prompt and print a single settled line in its place. */
  settle(line: string): void {
    this.erase();
    this.write(`${line}\n`);
    this.height = 0;
  }
}

/** Truncate to fit the terminal, accounting for the marker already printed. */
export function fit(text: string, width: number): string {
  if (width <= 1 || text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}
