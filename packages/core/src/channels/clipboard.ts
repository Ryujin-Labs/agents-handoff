import { spawnSync } from 'node:child_process';
import { platform } from 'node:process';
import { which } from '../util/which.ts';
import type { HandoffChannel, SendContext, SendResult } from './types.ts';

interface ClipboardCommand {
  command: string;
  args: string[];
}

function clipboardCommand(): ClipboardCommand | null {
  if (platform === 'darwin') return { command: 'pbcopy', args: [] };
  if (platform === 'win32') return { command: 'clip', args: [] };
  for (const candidate of [
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
  ]) {
    if (which(candidate.command)) return candidate;
  }
  return null;
}

/**
 * Put the handoff on the clipboard, ready to paste into Slack, Discord or a chat window.
 * This is the fastest real delivery path there is, and it needs no integration at all.
 */
export const clipboardChannel: HandoffChannel = {
  id: 'clipboard',
  kind: 'local',
  description: 'Copy the handoff to the system clipboard.',
  isAvailable: () => clipboardCommand() !== null,
  async send(context: SendContext): Promise<SendResult> {
    const clipboard = clipboardCommand();
    if (!clipboard) {
      return {
        ok: false,
        destination: 'clipboard',
        message: 'No clipboard command found (tried pbcopy, clip, wl-copy, xclip, xsel).',
      };
    }
    const result = spawnSync(clipboard.command, clipboard.args, {
      input: context.markdown,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      return {
        ok: false,
        destination: 'clipboard',
        message: `${clipboard.command} failed: ${result.stderr || 'unknown error'}`,
      };
    }
    return {
      ok: true,
      destination: 'clipboard',
      message: `Copied ${context.handoff.frontmatter.id} to the clipboard. Paste it wherever your teammate is.`,
    };
  },
};
