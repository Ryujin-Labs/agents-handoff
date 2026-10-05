import type { PromptIO } from './prompt/index.ts';

/**
 * Whether this run may stop and ask the user something.
 *
 * This exists because the same binary serves two callers with opposite needs. A developer
 * at a terminal wants to be asked; a coding agent running `handoff context --target mobile`
 * through a Bash tool will hang forever on a prompt it cannot see or answer. So prompting
 * is enabled only when both streams are a TTY, and `--no-input` turns it off outright for
 * scripts and CI.
 */
export interface Session {
  interactive: boolean;
  /**
   * Streams the prompts read and write. Left unset in real use, where the process streams
   * are correct; set by tests so an interactive flow can be driven end to end without a
   * pseudo-terminal.
   */
  io?: PromptIO;
}

let current: Session = { interactive: false };

export function setSession(session: Session): void {
  current = session;
}

/** True when it is safe to prompt. */
export function canPrompt(): boolean {
  return current.interactive;
}

/** The prompt streams for this run. */
export function sessionIO(): PromptIO | undefined {
  return current.io;
}

export function detectInteractive(noInput: boolean): boolean {
  if (noInput) return false;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}
