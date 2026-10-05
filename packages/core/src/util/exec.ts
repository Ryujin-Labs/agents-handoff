import { execFileSync } from 'node:child_process';

export interface RunOptions {
  cwd: string;
  /** Bytes of stdout to accept before the call fails. Defaults to 32 MiB. */
  maxBuffer?: number;
  timeoutMs?: number;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  /** Present only when `ok` is false. */
  error?: string;
  /** True when the command was killed for exceeding its time budget. */
  timedOut?: boolean;
}

/**
 * How long a single git call may take. Generous, because a cold index on a large
 * repository can take seconds, and overridable because "large" has no fixed ceiling.
 */
const DEFAULT_TIMEOUT_MS = (() => {
  const configured = Number(process.env['HANDOFF_GIT_TIMEOUT_MS']);
  return Number.isFinite(configured) && configured > 0 ? configured : 45_000;
})();

/**
 * Run a binary and capture stdout. Never throws: a failed command is a normal, expected
 * outcome (no git, shallow clone, no commits yet) and callers decide what it means.
 */
export function run(command: string, args: string[], options: RunOptions): RunResult {
  try {
    const stdout = execFileSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { ok: true, stdout };
  } catch (error) {
    const err = error as {
      stderr?: Buffer | string;
      message?: string;
      code?: string;
      signal?: string;
    };
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf8');
    // execFileSync reports a timeout by killing the child, which surfaces as a signal
    // rather than a distinct error code.
    const timedOut = err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM';
    const message = timedOut
      ? `timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms (raise HANDOFF_GIT_TIMEOUT_MS)`
      : (stderr || err.message || 'command failed').trim();
    return timedOut
      ? { ok: false, stdout: '', error: message, timedOut: true }
      : { ok: false, stdout: '', error: message };
  }
}
