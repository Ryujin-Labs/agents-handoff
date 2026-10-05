import type { Readable, Writable } from 'node:stream';
import { sessionIO } from '../session.ts';
import { style } from '../ui.ts';
import { decodeKey, movementFor, type Key } from './keys.ts';
import { fit, Renderer } from './render.ts';

/** Streams a prompt reads and writes. Injectable so the prompts are testable. */
export interface PromptIO {
  input: Readable & { setRawMode?: (mode: boolean) => void; isTTY?: boolean };
  output: Writable;
  /** Terminal width, for truncation. */
  columns: number;
}

export function defaultIO(): PromptIO {
  // A session may carry substitute streams; without one, the process streams are correct.
  const injected = sessionIO();
  if (injected) return injected;
  return {
    input: process.stdin,
    output: process.stdout,
    columns: process.stdout.columns ?? 80,
  };
}

/** Thrown when the user presses Ctrl+C or Escape. Callers exit quietly. */
export class PromptCancelled extends Error {
  override readonly name = 'PromptCancelled';
  constructor() {
    super('cancelled');
  }
}

const MARK = {
  pending: style.cyan('?'),
  done: style.green('✓'),
  cursor: '❯',
  on: '◉',
  off: '◯',
};

/**
 * Read keypresses until `handle` returns a result.
 *
 * Raw mode is entered for the duration and always restored, including when the caller
 * throws — a prompt that leaves a terminal in raw mode on the way out is worse than no
 * prompt at all.
 */
async function capture<T>(
  io: PromptIO,
  handle: (key: Key) => { done: true; value: T } | { done: false },
): Promise<T> {
  const { input } = io;
  const wasRaw = Boolean((input as { isRaw?: boolean }).isRaw);
  input.setRawMode?.(true);
  input.resume();
  input.setEncoding('utf8');

  try {
    return await new Promise<T>((resolve, reject) => {
      const onData = (chunk: string): void => {
        // A paste or a fast keypress can deliver several sequences in one chunk.
        for (const sequence of splitSequences(chunk)) {
          let outcome: { done: true; value: T } | { done: false };
          try {
            outcome = handle(decodeKey(sequence));
          } catch (error) {
            cleanup();
            reject(error);
            return;
          }
          if (outcome.done) {
            cleanup();
            resolve(outcome.value);
            return;
          }
        }
      };
      const cleanup = (): void => {
        input.off('data', onData);
        input.pause();
      };
      input.on('data', onData);
    });
  } finally {
    input.setRawMode?.(wasRaw);
  }
}

/** Split a chunk into individual key sequences, keeping escape sequences intact. */
export function splitSequences(chunk: string): string[] {
  const sequences: string[] = [];
  let index = 0;
  while (index < chunk.length) {
    const char = chunk[index] ?? '';
    if (char === '\u001b') {
      // CSI and SS3 sequences are three characters here; a lone ESC is its own key.
      const next = chunk[index + 1];
      if (next === '[' || next === 'O') {
        sequences.push(chunk.slice(index, index + 3));
        index += 3;
        continue;
      }
    }
    sequences.push(char);
    index += 1;
  }
  return sequences;
}

export interface Choice<T> {
  value: T;
  label: string;
  /** Dimmed text after the label. */
  hint?: string;
}

export interface SelectOptions<T> {
  message: string;
  choices: Array<Choice<T>>;
  /** Index selected when the prompt opens. */
  initial?: number;
  io?: PromptIO;
}

/** Single choice from a list, moved with the arrow keys. */
export async function select<T>(options: SelectOptions<T>): Promise<T> {
  const io = options.io ?? defaultIO();
  const { choices, message } = options;
  if (choices.length === 0) throw new Error(`select("${message}") was given no choices`);

  const renderer = new Renderer(io.output);
  let index = Math.min(Math.max(options.initial ?? 0, 0), choices.length - 1);

  const draw = (): void => {
    const lines = [`${MARK.pending} ${style.bold(message)}`];
    for (const [position, choice] of choices.entries()) {
      const active = position === index;
      const marker = active ? style.cyan(MARK.cursor) : ' ';
      const label = active ? style.cyan(choice.label) : choice.label;
      const hint = choice.hint ? style.dim(`  ${choice.hint}`) : '';
      lines.push(fit(`${marker} ${label}${hint}`, io.columns));
    }
    lines.push(style.dim('  ↑↓ move · enter select · ctrl+c cancel'));
    renderer.render(lines);
  };

  renderer.hideCursor();
  draw();
  try {
    const chosen = await capture<Choice<T>>(io, (key) => {
      if (key.name === 'abort' || key.name === 'escape' || key.name === 'eof') {
        throw new PromptCancelled();
      }
      const move = movementFor(key);
      if (move === 'up') {
        index = (index - 1 + choices.length) % choices.length;
        draw();
        return { done: false };
      }
      if (move === 'down') {
        index = (index + 1) % choices.length;
        draw();
        return { done: false };
      }
      if (key.name === 'enter') {
        const choice = choices[index];
        if (choice) return { done: true, value: choice };
      }
      return { done: false };
    });
    renderer.settle(`${MARK.done} ${style.bold(message)} ${style.cyan(chosen.label)}`);
    return chosen.value;
  } catch (error) {
    renderer.erase();
    throw error;
  } finally {
    renderer.showCursor();
  }
}

export interface MultiSelectOptions<T> {
  message: string;
  choices: Array<Choice<T>>;
  /** Values selected when the prompt opens. */
  initial?: T[];
  /** Reject an empty selection. */
  required?: boolean;
  io?: PromptIO;
}

/** Any number of choices, toggled with space. */
export async function multiselect<T>(options: MultiSelectOptions<T>): Promise<T[]> {
  const io = options.io ?? defaultIO();
  const { choices, message } = options;
  if (choices.length === 0) throw new Error(`multiselect("${message}") was given no choices`);

  const renderer = new Renderer(io.output);
  const chosen = new Set<T>(options.initial ?? []);
  let index = 0;
  let warn = '';

  const draw = (): void => {
    const lines = [`${MARK.pending} ${style.bold(message)}`];
    for (const [position, choice] of choices.entries()) {
      const active = position === index;
      const on = chosen.has(choice.value);
      const marker = active ? style.cyan(MARK.cursor) : ' ';
      const box = on ? style.green(MARK.on) : style.dim(MARK.off);
      const label = active ? style.cyan(choice.label) : choice.label;
      const hint = choice.hint ? style.dim(`  ${choice.hint}`) : '';
      lines.push(fit(`${marker} ${box} ${label}${hint}`, io.columns));
    }
    lines.push(style.dim('  ↑↓ move · space toggle · enter confirm · ctrl+c cancel'));
    if (warn) lines.push(style.yellow(`  ${warn}`));
    renderer.render(lines);
  };

  renderer.hideCursor();
  draw();
  try {
    const values = await capture<T[]>(io, (key) => {
      if (key.name === 'abort' || key.name === 'escape' || key.name === 'eof') {
        throw new PromptCancelled();
      }
      const move = movementFor(key);
      if (move === 'up') {
        index = (index - 1 + choices.length) % choices.length;
        warn = '';
        draw();
        return { done: false };
      }
      if (move === 'down') {
        index = (index + 1) % choices.length;
        warn = '';
        draw();
        return { done: false };
      }
      if (key.name === 'space') {
        const choice = choices[index];
        if (choice) {
          if (chosen.has(choice.value)) chosen.delete(choice.value);
          else chosen.add(choice.value);
        }
        warn = '';
        draw();
        return { done: false };
      }
      if (key.name === 'enter') {
        if (options.required && chosen.size === 0) {
          warn = 'pick at least one, with space';
          draw();
          return { done: false };
        }
        return { done: true, value: [...chosen] };
      }
      return { done: false };
    });
    const labels = choices.filter((c) => values.includes(c.value)).map((c) => c.label);
    renderer.settle(
      `${MARK.done} ${style.bold(message)} ${style.cyan(labels.join(', ') || '(none)')}`,
    );
    return values;
  } catch (error) {
    renderer.erase();
    throw error;
  } finally {
    renderer.showCursor();
  }
}

export interface TextOptions {
  message: string;
  /** Offered as the value when the user presses enter on an empty field. */
  default?: string;
  placeholder?: string;
  /** Return a message to reject the value, or null to accept. */
  validate?: (value: string) => string | null;
  io?: PromptIO;
}

/** A single line of free text. */
export async function text(options: TextOptions): Promise<string> {
  const io = options.io ?? defaultIO();
  const renderer = new Renderer(io.output);
  let value = '';
  let error = '';

  const draw = (): void => {
    const shown = value || style.dim(options.default ?? options.placeholder ?? '');
    const lines = [fit(`${MARK.pending} ${style.bold(options.message)} ${shown}`, io.columns)];
    if (error) lines.push(style.yellow(`  ${error}`));
    else if (options.default) lines.push(style.dim('  enter to accept · ctrl+c cancel'));
    renderer.render(lines);
  };

  draw();
  try {
    const result = await capture<string>(io, (key) => {
      if (key.name === 'abort' || key.name === 'eof') throw new PromptCancelled();
      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        error = '';
        draw();
        return { done: false };
      }
      if (key.name === 'char' && key.char) {
        value += key.char;
        error = '';
        draw();
        return { done: false };
      }
      if (key.name === 'space') {
        value += ' ';
        error = '';
        draw();
        return { done: false };
      }
      if (key.name === 'enter') {
        const settled = value.trim() || options.default || '';
        const problem = options.validate?.(settled) ?? null;
        if (problem) {
          error = problem;
          draw();
          return { done: false };
        }
        return { done: true, value: settled };
      }
      return { done: false };
    });
    renderer.settle(`${MARK.done} ${style.bold(options.message)} ${style.cyan(result)}`);
    return result;
  } catch (err) {
    renderer.erase();
    throw err;
  }
}

export interface ConfirmOptions {
  message: string;
  default?: boolean;
  io?: PromptIO;
}

/** A yes/no question. */
export async function confirm(options: ConfirmOptions): Promise<boolean> {
  const fallback = options.default ?? true;
  return select<boolean>({
    message: options.message,
    choices: [
      { value: true, label: 'Yes' },
      { value: false, label: 'No' },
    ],
    initial: fallback ? 0 : 1,
    ...(options.io ? { io: options.io } : {}),
  });
}

/** Print a heading above a group of prompts. */
export function section(output: Writable, title: string): void {
  output.write(`\n${style.bold(title)}\n`);
}

export { PromptCancelled as Cancelled };
