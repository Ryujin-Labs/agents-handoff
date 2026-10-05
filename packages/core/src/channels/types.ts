import type { ChannelSettings } from '../config/channels.ts';
import type { Handoff } from '../types.ts';

/**
 * What a channel actually does.
 *
 * The distinction is load-bearing rather than cosmetic: `push` uploads the handoff to a
 * third party and needs a credential, while `compose` only opens an app with the message
 * ready. Presenting them as the same thing would misrepresent both the privacy cost and
 * what the developer still has to do.
 */
export type ChannelKind = 'local' | 'push' | 'compose';

export interface SendResult {
  ok: boolean;
  /** A link that was opened, or should be. */
  url?: string;
  /** A shareable URL that was created and put in the message. */
  shareUrl?: string;
  /** Who can read what is at `shareUrl`. Stated so nobody has to assume. */
  shareVisibility?: string;
  /** What the developer still has to do, when anything is left. */
  nextStep?: string;
  /**
   * True when only a draft was opened. Nothing has reached the recipient until the
   * developer presses send, so no caller may report this as sent.
   */
  composed?: boolean;
  /** For a compose channel: whether the app actually opened, or only a link was printed. */
  opened?: boolean;
  /**
   * What the handoff was uploaded to on the way, e.g. a secret gist for a link. A draft can
   * be unsent and the document still have left the machine, and the developer is told so.
   */
  uploaded?: string;
  /** Where the handoff ended up, phrased for a human: a path, "clipboard", a URL. */
  destination: string;
  /** One line describing what happened, shown by the CLI. */
  message: string;
}

export interface SendContext {
  /** Configured settings for this channel, with `${ENV}` already expanded. */
  settings?: ChannelSettings | undefined;
  /** Rendered Markdown of the handoff. */
  markdown: string;
  handoff: Handoff;
  /** Absolute path to the stored handoff, when it has one. */
  sourcePath?: string;
  cwd: string;
  /** Channel-specific option, e.g. a destination path. */
  destination?: string | undefined;
  /**
   * Open links and stage the clipboard. On by default: a printed URL is not delivery.
   * Turned off for scripts, CI, and tests that must not launch an application.
   */
  open?: boolean | undefined;
  /** Override the channel's configured link mode for this send. */
  link?: 'repo' | 'gist' | 'none' | undefined;
  /**
   * Where to put the copy named after the handoff that a chat or mail message attaches.
   * Callers that must stay inside the project — the MCP server — pass a directory there;
   * when unset, a private temporary directory is made for the send.
   */
  stagingDir?: string | undefined;
}

/**
 * A way to move a handoff to another person.
 *
 * Kept to one method on purpose. Delivery is not this project's problem — a handoff is a
 * file, and the file already travels fine through Slack, email and pull requests. This
 * interface exists so that adding a channel later never requires changing the core.
 */
export interface HandoffChannel {
  id: string;
  kind: ChannelKind;
  description: string;
  /** What must be configured for this channel to work, named for an error message. */
  requires?: string;
  /** False when the channel cannot run here: no clipboard, no credential, no `gh`. */
  isAvailable(settings?: ChannelSettings | undefined): boolean;
  send(context: SendContext): Promise<SendResult>;
}
