import { clipboardChannel } from './clipboard.ts';
import { filesystemChannel } from './filesystem.ts';
import {
  discordChannel,
  emailChannel,
  githubChannel,
  slackChannel,
  trelloChannel,
  whatsappChannel,
} from './remote.ts';
import { createStdoutChannel, stdoutChannel } from './stdout.ts';
import type { HandoffChannel } from './types.ts';

/**
 * Every way a handoff can leave this machine.
 *
 * The local three come first and remain the default, because they need no configuration
 * and upload nothing. The rest are opt-in: each needs a webhook, a recipient or an
 * authenticated CLI before it appears as a route at all.
 */
export const BUILTIN_CHANNELS: readonly HandoffChannel[] = [
  filesystemChannel,
  clipboardChannel,
  stdoutChannel,
  slackChannel,
  discordChannel,
  trelloChannel,
  githubChannel,
  whatsappChannel,
  emailChannel,
];

export function findChannel(id: string): HandoffChannel | undefined {
  return BUILTIN_CHANNELS.find((channel) => channel.id === id);
}

export * from './types.ts';
export { filesystemChannel, clipboardChannel, stdoutChannel, createStdoutChannel };
export type { WriteSink } from './stdout.ts';
export { slackChannel, discordChannel, trelloChannel, githubChannel, whatsappChannel, emailChannel };
export { chatSummary, chatOpener, repoLink, shareLink } from './remote.ts';
export type { LinkResult } from './remote.ts';
