import { spawnSync } from 'node:child_process';
import { platform } from 'node:process';
import { which } from './which.ts';

/**
 * The small amount of desktop integration that makes delivery feel finished.
 *
 * Printing a URL and calling it delivery is the gap between "the tool did something" and
 * "the message is on its way". Opening a draft and revealing its file helps the developer
 * attach it manually. A clipboard file reference is a convenience; whether a paste
 * attaches it depends on the client. No desktop operation sends the message.
 */

export interface OpenResult {
  ok: boolean;
  /** What went wrong, when it did. */
  error?: string;
}

/** Open a URL or file with whatever the desktop uses for it. */
export function openExternal(target: string): OpenResult {
  const opener = openerFor();
  if (!opener) {
    return { ok: false, error: `No way to open things on ${platform}.` };
  }
  const result = spawnSync(opener.command, [...opener.args, target], {
    stdio: 'ignore',
    // Detached so a slow-starting app never holds up the caller.
    timeout: 15_000,
  });
  return result.status === 0
    ? { ok: true }
    : { ok: false, error: `${opener.command} exited ${result.status ?? 'without a status'}` };
}

function openerFor(): { command: string; args: string[] } | null {
  if (platform === 'darwin') return { command: 'open', args: [] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', ''] };
  const linux = ['xdg-open', 'gio', 'gnome-open'].find((candidate) => which(candidate));
  if (!linux) return null;
  return linux === 'gio' ? { command: 'gio', args: ['open'] } : { command: linux, args: [] };
}

/**
 * Put a *file reference* on the clipboard; some chat clients accept it as an attachment.
 *
 * Distinct from copying the file's text: pasting text into WhatsApp gives a wall of
 * markdown, while pasting a file reference attaches the document. Only macOS exposes this
 * reliably from a script, so elsewhere we say so rather than pretending.
 */
export function copyFileToClipboard(path: string): OpenResult {
  if (platform !== 'darwin') {
    return {
      ok: false,
      error: 'Putting a file on the clipboard is only supported on macOS from here.',
    };
  }
  const script = `set the clipboard to (POSIX file ${JSON.stringify(path)})`;
  const result = spawnSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 10_000 });
  return result.status === 0
    ? { ok: true }
    : { ok: false, error: 'osascript could not set the clipboard' };
}

/** Show the file in the desktop file manager, as a fallback for dragging it in. */
export function revealFile(path: string): OpenResult {
  if (platform === 'darwin') {
    const result = spawnSync('open', ['-R', path], { stdio: 'ignore', timeout: 10_000 });
    return result.status === 0 ? { ok: true } : { ok: false, error: 'could not reveal the file' };
  }
  return openExternal(path.replace(/[^/\\]+$/, ''));
}

/**
 * True when some application claims a URL scheme.
 *
 * Used to prefer a native app over a web detour: `whatsapp://send?...` opens the desktop
 * client, while `https://wa.me/...` bounces through a browser first.
 */
export function hasUrlHandler(scheme: string): boolean {
  if (platform !== 'darwin') return false;
  const normalized = scheme.endsWith(':') ? scheme : `${scheme}:`;
  // It goes into a script below, so only a well-formed scheme is ever looked up.
  if (!/^[a-z][a-z0-9+.-]*:$/i.test(normalized)) return false;
  const cached = handlerCache.get(normalized);
  if (cached !== undefined) return cached;
  // Ask Launch Services which app would open the scheme, without opening anything. The
  // old probe (`open -g whatsapp://probe`) sent a URL to the app, so it launched WhatsApp
  // even for a send that was told not to open anything.
  const script =
    "ObjC.import('AppKit'); var u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(" +
    `$.NSURL.URLWithString('${normalized}//x')); (u && !u.isNil()) ? ObjC.unwrap(u.path) : ''`;
  const probe = spawnSync('osascript', ['-l', 'JavaScript', '-e', script], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  const found = probe.status === 0 && String(probe.stdout ?? '').trim().length > 0;
  handlerCache.set(normalized, found);
  return found;
}

const handlerCache = new Map<string, boolean>();

/** True when this machine can open links at all. */
export function canOpen(): boolean {
  return openerFor() !== null;
}

/** True when a paste will attach a file rather than dump text. */
export function canCopyFile(): boolean {
  return platform === 'darwin';
}
