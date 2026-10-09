import { spawnSync } from 'node:child_process';
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { findSection } from '../markdown/sections.ts';
import { truncate } from '../util/text.ts';
import { canCopyFile, copyFileToClipboard, hasUrlHandler, openExternal, revealFile } from '../util/desktop.ts';
import { Git, repoHost, repoSlug } from '../git/index.ts';
import { prepareOutbox } from '../util/fs.ts';
import { which } from '../util/which.ts';
import type { HandoffChannel, SendContext, SendResult } from './types.ts';

/**
 * Channels that reach a teammate rather than the local machine.
 *
 * Two honest categories, because the platforms genuinely differ:
 *
 * - **push** actually delivers. It needs a credential and it uploads the handoff, so it is
 *   opt-in, configured explicitly, and never fires without the developer asking.
 * - **compose** opens the app with the message ready and the developer presses send. This
 *   is the only mechanism WhatsApp offers for this job — its Cloud API is built for
 *   customer service and refuses business-initiated free text outside a 24-hour window
 *   unless it matches a pre-approved template, which a software handoff never will.
 */

const SLACK_TEXT_LIMIT = 38_000;

/**
 * How much prefilled text a chat link carries.
 *
 * Short on purpose. A click-to-chat link is an opening line, not the document: the handoff
 * itself is the attachment, and a thousand characters of markdown in a chat box is
 * something a person deletes before typing their own message.
 */
const CHAT_PREFILL_LIMIT = 320;

/** How much of the Summary an opening line quotes before it gives up on the rest. */
const OPENER_SUMMARY_LIMIT = 160;

/** A short, useful message for a chat window: what it is and what the reader must do. */
export function chatSummary(context: SendContext, actionLimit = 900): string {
  const fm = context.handoff.frontmatter;
  const summary = findSection(context.handoff.sections, 'Summary')?.content.trim() ?? '';
  const actions = findSection(context.handoff.sections, 'Required Actions')?.content.trim() ?? '';

  const lines = [
    `*${context.handoff.title}*`,
    `from ${fm.source.project}${fm.source.branch ? ` (${fm.source.branch})` : ''}` +
      ` → ${fm.targets.join(', ') || 'any consumer'}${fm.breaking ? ' · BREAKING' : ''}`,
  ];
  if (summary) lines.push('', truncate(summary, 600));
  if (actions) lines.push('', 'Required actions:', truncate(actions, actionLimit));
  return lines.join('\n');
}

/**
 * The opening line for a chat window.
 *
 * It must describe what the reader will actually receive. Saying "file attached" when
 * nothing is attached is worse than saying nothing: the recipient looks for a document
 * that is not there and concludes the sender made a mistake.
 *
 * A configured `template` replaces the default wording; `{title}`, `{who}`, `{summary}`
 * and `{url}` are filled in.
 */
export function chatOpener(context: SendContext, shareUrl?: string): string {
  const fm = context.handoff.frontmatter;
  const who = fm.targets.join('/') || 'you';
  const url = shareUrl ?? '';
  const summary = truncate(
    (findSection(context.handoff.sections, 'Summary')?.content ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.!?]+$/, ''),
    OPENER_SUMMARY_LIMIT,
  );
  const template = context.settings?.template;

  // A template that leaves `{url}` out still gets the link, at the end: the link is how the
  // reader gets the document, and without it they would get neither a link nor a file.
  const withUrl = template && url && !template.includes('{url}') ? `${template} {url}` : template;
  const fields = (title: string, snippet: string): Record<string, string> => ({
    title,
    who,
    summary: snippet,
    url,
  });
  // Filled with a function, not a replacement string: `$&` or `$'` in a title would
  // otherwise be read as a pattern and splice the template into itself.
  const render = (title: string, snippet: string): string =>
    withUrl
      ? withUrl
          .replace(/\{(title|who|summary|url)\}/g, (_, key: string) => fields(title, snippet)[key] ?? '')
          .trim()
      : `Handoff for ${who}: ${title}.${fm.breaking ? ' Breaking change.' : ''}` +
        `${snippet ? ` ${snippet}.` : ''}` +
        `${url ? ` Read it here: ${url}` : ''}`;

  return fitWithinLimit(render, context.handoff.title, summary, CHAT_PREFILL_LIMIT);
}

/**
 * Shorten an opening line to the limit without ever shortening its link.
 *
 * A truncated URL is a broken one, and it looks whole to the person pressing send. So the
 * summary gives way first, then the title; the link is never touched. When a long link
 * alone outruns the limit the line is allowed to run long, because the limit is a matter
 * of taste and the link is the point.
 */
function fitWithinLimit(
  render: (title: string, summary: string) => string,
  title: string,
  summary: string,
  limit: number,
): string {
  const full = render(title, summary);
  if (full.length <= limit) return full;

  const overflow = full.length - limit;
  const shorterSummary = summary.length > overflow + 1 ? truncate(summary, summary.length - overflow) : '';
  const withoutSummary = render(title, shorterSummary);
  if (withoutSummary.length <= limit) return withoutSummary;

  const titleRoom = Math.max(24, title.length - (withoutSummary.length - limit));
  return render(truncate(title, titleRoom), shorterSummary);
}

/** Where a link points, and who can read what is at the other end. */
export interface LinkResult {
  url?: string;
  /** Plain-language statement of who can read it. Shown to the developer, never guessed. */
  visibility?: string;
  /** Set when making the link uploaded the handoff somewhere: it has left the machine. */
  uploaded?: string;
  error?: string;
}

/**
 * How each forge spells a link to a file on a branch.
 *
 * Only forges whose URL shape is certain are listed. A self-hosted instance could put its
 * blob route anywhere, and a link that 404s is worse than an honest "not supported".
 */
const FORGE_FILE_URL: Record<string, (slug: string, ref: string, path: string) => string> = {
  'github.com': (slug, ref, path) => `https://github.com/${slug}/blob/${ref}/${path}`,
  'gitlab.com': (slug, ref, path) => `https://gitlab.com/${slug}/-/blob/${ref}/${path}`,
  'bitbucket.org': (slug, ref, path) => `https://bitbucket.org/${slug}/src/${ref}/${path}`,
};

function encodeSegments(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

/**
 * A link to the handoff where it already lives in the repository.
 *
 * The most private option by a distance, and usually the cheapest: nothing is uploaded,
 * because the document is already committed. A forge URL into a private repository is
 * readable by exactly the people who can read the repository, and unreadable — and so
 * unindexable — by everyone else.
 */
export function repoLink(context: SendContext): LinkResult {
  const git = new Git(context.cwd);
  if (!git.isRepo()) return { error: 'not a git repository' };

  const branch = git.branch();
  if (!branch) return { error: 'not on a branch' };

  const upstream = git.upstream(branch);
  if (!upstream) return { error: `${branch} has not been pushed, so a link to it would 404` };

  const remoteUrl = git.remoteUrlOf(upstream.remote);
  const slug = remoteUrl ? repoSlug(remoteUrl) : null;
  if (!slug) return { error: `the remote ${upstream.remote} has no URL a link can be built from` };

  const host = (remoteUrl ? repoHost(remoteUrl) : null) ?? '';
  const build = FORGE_FILE_URL[host];
  if (!build) {
    return {
      error: `repository links are built for GitHub, GitLab and Bitbucket, and ${host || 'this remote'} is none of them — use a different link mode`,
    };
  }

  const path = context.sourcePath ? git.relativeToRoot(context.sourcePath) : null;
  if (!path) return { error: 'the handoff is not inside this repository' };

  if (!git.fileExistsAt(upstream.ref, path)) {
    return {
      error: `${path} is not in ${upstream.ref} yet — commit and push it, or use a different link mode`,
    };
  }

  // The branch as the forge knows it, which is not always the local name.
  return {
    url: build(encodeSegments(slug), encodeSegments(upstream.branch), encodeSegments(path)),
    visibility: `whoever can read ${slug} on ${host}`,
  };
}

/**
 * Upload the handoff as a secret gist and return its URL.
 *
 * "Secret" is GitHub's word and it does not mean private: the gist is unlisted and absent
 * from search on GitHub, but anyone who comes by the URL can read it, and gist pages are
 * not disallowed in GitHub's robots.txt. Fine for a handoff whose contents would not
 * matter if they leaked; wrong for anything else, which is why the visibility is stated
 * rather than left to be assumed from the word "secret".
 */
async function gistLink(context: SendContext): Promise<LinkResult> {
  if (!which('gh')) return { error: 'the gh CLI is not installed' };
  const result = await githubChannel.send({ ...context, link: 'none' });
  return result.ok
    ? {
        url: result.destination,
        visibility: 'anyone with the link, GitHub account or not',
        uploaded: 'a secret gist on GitHub',
      }
    : { error: result.message };
}

/** Resolve the configured link mode into a URL, or an explained absence. */
export async function shareLink(context: SendContext): Promise<LinkResult> {
  const mode = context.link ?? context.settings?.link ?? 'none';
  if (mode === 'none') return {};
  if (mode === 'repo') return repoLink(context);
  return gistLink(context);
}

/**
 * Write the document under a name that means something to the person receiving it.
 *
 * Every handoff is stored as `HANDOFF.md`, which is the right name inside a repository and
 * a useless one in a chat: five attachments all called HANDOFF.md are indistinguishable.
 * The copy is written fresh on every send, so it can never be an older revision than the
 * one being delivered. It goes in the caller's staging directory — the project's
 * `.handoff/outbox/`, which ignores itself in git — or a private temporary directory, never
 * next to the original, where it would be committed as a second copy that drifts.
 */
function namedCopy(context: SendContext): string | null {
  const id = context.handoff.frontmatter.id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  if (!id || !context.markdown) return null;
  try {
    // Inside the project when the caller says so; otherwise a fresh private directory for
    // this send, since a fixed name under a shared /tmp can be planted in advance.
    const dir = context.stagingDir ? prepareOutbox(context.stagingDir) : mkdtempSync(join(tmpdir(), 'agents-handoff-'));
    const path = join(dir, `${id}.md`);
    // Written beside the name and renamed over it: a rename replaces whatever is there, a
    // planted symlink included, where a write would follow it.
    const temp = join(dir, `.${id}.${process.pid}.tmp`);
    writeFileSync(temp, context.markdown, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
    return path;
  } catch {
    return null;
  }
}

/**
 * Make the document as easy to attach as the platform allows.
 *
 * Revealing it in Finder is the reliable gesture: a clipboard file reference pastes into
 * some chat clients and silently does nothing in others, so it is offered as a bonus and
 * never as the instruction.
 */
function stageAttachment(context: SendContext, preparedPath?: string): string {
  const file = preparedPath ?? namedCopy(context) ?? context.sourcePath;
  if (!file) return 'Attach the handoff file before sending.';
  const instruction = `Attach ${file} before sending.`;
  if (context.open === false) return instruction;

  const revealed = revealFile(file);
  const copied = canCopyFile() ? copyFileToClipboard(file) : { ok: false };
  const name = basename(file);
  const location = revealed.ok
    ? `The file "${name}" is shown in the file manager; drag it into your draft.`
    : 'The file manager could not be opened; use the path above to attach the file.';
  const clipboard = copied.ok ? ' A file reference is also on the clipboard; pasting depends on your mail or chat client.' : '';
  return `${instruction} ${location}${clipboard}`;
}

/**
 * Where the full document can be found, for a channel that only carries a summary.
 *
 * Never the absolute path: it names the sender's machine and home directory, and it opens
 * nothing for anyone else. The path inside the repository at least tells a teammate where
 * to look once the change is pushed.
 */
function documentReference(context: SendContext): string {
  const inRepo = context.sourcePath ? new Git(context.cwd).relativeToRoot(context.sourcePath) : null;
  return inRepo ?? context.handoff.frontmatter.id;
}

function requireWebhook(context: SendContext, name: string): string {
  const webhook = context.settings?.webhook?.trim();
  if (!webhook) {
    throw new Error(
      `No ${name} webhook configured. Set channels.${name}.webhook in handoff.config.json — ` +
        `use \${${name.toUpperCase()}_WEBHOOK_URL} and put the real URL in your environment.`,
    );
  }
  if (!/^https:\/\//.test(webhook)) throw new Error(`The ${name} webhook must be an https URL.`);
  return webhook;
}

/**
 * Slack incoming webhook.
 *
 * Webhooks post text only — they cannot attach a file — so this sends the summary and the
 * required actions, and says where the full document is: a link when a link mode is
 * configured, otherwise its path in the repository. Posting 700 lines of markdown into a
 * channel would not be read anyway.
 */
export const slackChannel: HandoffChannel = {
  id: 'slack',
  kind: 'push',
  description: 'Post the summary and required actions to a Slack channel.',
  requires: 'channels.slack.webhook',
  isAvailable: (settings) => Boolean(settings?.webhook),
  async send(context: SendContext): Promise<SendResult> {
    const webhook = requireWebhook(context, 'slack');
    const link = await shareLink(context);
    const where = link.url
      ? `Full handoff: ${link.url}`
      : `Full handoff: \`${documentReference(context)}\` in ${context.handoff.frontmatter.source.project}`;
    const text = truncate(`${chatSummary(context)}\n\n${where}`, SLACK_TEXT_LIMIT);

    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const body = await response.text();
    if (!response.ok || body.trim() !== 'ok') {
      return {
        ok: false,
        destination: 'slack',
        message: `Slack rejected the message (${response.status}): ${truncate(body, 200)}`,
      };
    }

    const label = context.settings?.label ?? 'Slack';
    const trouble = link.error ? ` (no link: ${link.error})` : '';
    const result: SendResult = {
      ok: true,
      destination: context.settings?.label ?? 'slack',
      message: link.url
        ? `Posted the summary and a link to ${label}.`
        : `Posted the summary to ${label}.${trouble} Send them the file too — a webhook cannot attach one.`,
    };
    if (link.url) result.shareUrl = link.url;
    if (link.visibility) result.shareVisibility = link.visibility;
    if (link.uploaded) result.uploaded = link.uploaded;
    return result;
  },
};

/**
 * Discord incoming webhook.
 *
 * Unlike Slack, a Discord webhook accepts a file part, so the whole handoff goes across as
 * an attachment with the summary alongside it.
 */
export const discordChannel: HandoffChannel = {
  id: 'discord',
  kind: 'push',
  description: 'Post to a Discord channel, with the handoff attached as a file.',
  requires: 'channels.discord.webhook',
  isAvailable: (settings) => Boolean(settings?.webhook),
  async send(context: SendContext): Promise<SendResult> {
    const webhook = requireWebhook(context, 'discord');
    const form = new FormData();
    form.append(
      'payload_json',
      JSON.stringify({
        content: truncate(chatSummary(context, 600).replace(/\*/g, '**'), 1900),
        attachments: [{ id: 0, filename: `${context.handoff.frontmatter.id}.md` }],
      }),
    );
    form.append(
      'files[0]',
      new Blob([context.markdown], { type: 'text/markdown' }),
      `${context.handoff.frontmatter.id}.md`,
    );

    const response = await fetch(webhook, { method: 'POST', body: form });
    if (!response.ok) {
      return {
        ok: false,
        destination: 'discord',
        message: `Discord rejected the message (${response.status}): ${truncate(await response.text(), 200)}`,
      };
    }
    return {
      ok: true,
      destination: context.settings?.label ?? 'discord',
      message: `Posted to ${context.settings?.label ?? 'Discord'} with the handoff attached.`,
    };
  },
};

/** Trello caps a card description at 16,384 characters. */
const TRELLO_DESC_LIMIT = 16_000;

/**
 * A card on a Trello board.
 *
 * Two routes, because Trello offers two:
 *
 * - `webhook` is an https endpoint that accepts JSON. That can be Trello's own REST API —
 *   `https://api.trello.com/1/cards?idList=…&key=…&token=…`, where the unknown fields in
 *   the body are ignored and `name`/`desc` become the card — or an automation service
 *   that turns the same JSON into a card. The URL carries a credential either way, so it
 *   belongs in an environment variable. The full handoff becomes the card description.
 * - `to` is the board's email-to-board address. That route composes rather than pushes:
 *   a draft opens, the handoff is ready to attach, and Trello puts the attachment on the
 *   card when the developer sends it.
 */
export const trelloChannel: HandoffChannel = {
  id: 'trello',
  kind: 'push',
  description: 'Create a card on a Trello board with the handoff as its description.',
  requires: 'channels.trello.webhook or channels.trello.to',
  isAvailable: (settings) => Boolean(settings?.webhook || settings?.to),
  async send(context: SendContext): Promise<SendResult> {
    const webhook = context.settings?.webhook?.trim();
    const boardAddress = (context.destination ?? context.settings?.to ?? '').trim();
    const title = `[Handoff] ${context.handoff.title}`;

    if (webhook) {
      if (!/^https:\/\//.test(webhook)) {
        throw new Error('The Trello webhook must be an https URL.');
      }
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: title,
          desc: truncate(context.markdown, TRELLO_DESC_LIMIT),
          summary: chatSummary(context),
          targets: context.handoff.frontmatter.targets,
          breaking: context.handoff.frontmatter.breaking,
          handoff_id: context.handoff.frontmatter.id,
        }),
      });

      if (!response.ok) {
        return {
          ok: false,
          destination: 'trello',
          message: `Trello rejected the request (${response.status}): ${truncate(await response.text(), 200)}`,
        };
      }

      const label = context.settings?.label ?? 'Trello';
      return {
        ok: true,
        destination: label,
        message: `Created a card for "${context.handoff.title}" on ${label}.`,
      };
    }

    if (boardAddress) {
      const link = await shareLink(context);
      const body = `${chatOpener(context, link.url)}\n\n${truncate(chatSummary(context, 900), 1400)}`;
      const url = `mailto:${encodeURIComponent(boardAddress)}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
      const attach = link.url ? '' : ` ${stageAttachment(context)} Trello attaches it to the card.`;
      const nextStep = `Send the email to create the card.${attach}`;
      const opened = context.open === false ? { ok: false } : openExternal(url);
      const trouble = link.error ? ` (no link: ${link.error})` : '';

      const result: SendResult = {
        ok: true,
        destination: context.settings?.label ?? boardAddress,
        url,
        nextStep,
        composed: true,
        message: opened.ok
          ? `Opened a draft to the board.${trouble} ${nextStep}`
          : `Open this to create the card: ${url}${trouble}\n${nextStep}`,
      };
      if (link.url) result.shareUrl = link.url;
      if (link.visibility) result.shareVisibility = link.visibility;
      if (link.uploaded) result.uploaded = link.uploaded;
      return result;
    }

    throw new Error(
      'No Trello webhook or board email configured. Set channels.trello.webhook or channels.trello.to in handoff.config.json.',
    );
  },
};

/**
 * A secret GitHub gist, via the `gh` CLI.
 *
 * The best answer for a long document: it produces a URL that renders the markdown and can
 * be pasted anywhere, which is what every chat platform actually wants.
 */
export const githubChannel: HandoffChannel = {
  id: 'github',
  kind: 'push',
  description: 'Create a secret gist — unlisted, but readable by anyone with the link.',
  requires: 'the gh CLI, authenticated',
  isAvailable: () => which('gh') !== null,
  async send(context: SendContext): Promise<SendResult> {
    const result = spawnSync(
      'gh',
      [
        'gist',
        'create',
        '--filename',
        `${context.handoff.frontmatter.id}.md`,
        '--desc',
        truncate(context.handoff.title, 120),
        '-',
      ],
      { input: context.markdown, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      return {
        ok: false,
        destination: 'github',
        message: `gh gist create failed: ${(result.stderr || result.stdout || '').trim()}`,
      };
    }
    const url = (result.stdout || '').trim().split('\n').pop() ?? '';
    return {
      ok: true,
      destination: url,
      shareUrl: url,
      shareVisibility: 'anyone with the link, GitHub account or not',
      message: `Created a secret gist: ${url}\nAnyone with the link can read it.`,
    };
  },
};

/**
 * WhatsApp click-to-chat.
 *
 * Opens WhatsApp with the message already written and lets the developer choose the chats
 * inside the app — including groups, which have no addressable number and so cannot be
 * reached any other way. Keeping a list of colleagues' phone numbers in a config file was
 * the wrong shape for this: the app already knows who everyone is.
 *
 * It composes; it does not send. WhatsApp's Cloud API is built for customer service and
 * refuses business-initiated free text outside a 24-hour window unless it matches a
 * pre-approved template, which a software handoff never will — and it would mean uploading
 * the document to Meta. Neither is a trade worth making for a message a person can send.
 */
export const whatsappChannel: HandoffChannel = {
  id: 'whatsapp',
  kind: 'compose',
  description: 'Open WhatsApp with a message ready; you pick the chats and press send.',
  isAvailable: () => true,
  async send(context: SendContext): Promise<SendResult> {
    const raw = (context.destination ?? context.settings?.to ?? '').trim();
    const number = raw.replace(/[^\d]/g, '');

    if (raw && number.length < 8) {
      return {
        ok: false,
        destination: 'whatsapp',
        message:
          `"${raw}" is not a usable number. Use international format with a country code, ` +
          'e.g. +905551112233 — or drop it entirely and pick the chat in WhatsApp.',
      };
    }

    const link = await shareLink(context);
    const text = encodeURIComponent(chatOpener(context, link.url));

    // No number is the good case, not an error: WhatsApp documents `wa.me/?text=` as the
    // form that opens a contact list to choose from, which beats keeping a directory of
    // phone numbers in a config file. A number is only a shortcut for "always this person".
    // Printing a link for a script: the portable https form, and no need to ask which app
    // handles the scheme.
    const url = number
      ? context.open !== false && hasUrlHandler('whatsapp:')
        ? `whatsapp://send?phone=${number}&text=${text}`
        : `https://wa.me/${number}?text=${text}`
      : `https://wa.me/?text=${text}`;

    const picking = !number;
    const nextStep = link.url
      ? picking
        ? 'Pick the chats you want, then send. Repeat for as many people as you like.'
        : 'Press send.'
      : stageAttachment(context);
    const opened = context.open === false ? { ok: false } : openExternal(url);
    const trouble = link.error ? ` (no link: ${link.error})` : '';

    const result: SendResult = {
      ok: true,
      destination: context.settings?.label ?? (number ? `+${number}` : 'WhatsApp (you pick)'),
      url,
      nextStep,
      composed: true,
      opened: opened.ok,
      message: opened.ok
        ? `${picking ? 'Opened WhatsApp — choose who to send to.' : `Opened WhatsApp for +${number}.`}${trouble} ${nextStep}`
        : `Open this to compose: ${url}${trouble}\n${nextStep}`,
    };
    if (link.url) result.shareUrl = link.url;
    if (link.visibility) result.shareVisibility = link.visibility;
    if (link.uploaded) result.uploaded = link.uploaded;
    return result;
  },
};

/** A single email preview; the unchanged Markdown export carries the full handoff. */
function emailBody(context: SendContext, shareUrl?: string): string {
  const fm = context.handoff.frontmatter;
  const summary = findSection(context.handoff.sections, 'Summary')?.content.trim() ?? '';
  const actions = findSection(context.handoff.sections, 'Required Actions')?.content.trim() ?? '';
  const template = context.settings?.template;
  const fields: Record<string, string> = {
    title: context.handoff.title,
    who: fm.targets.join('/') || 'you',
    summary: truncate(summary, 600),
    url: shareUrl ?? '',
  };
  const lines = template
    ? [template.replace(/\{(title|who|summary|url)\}/g, (_, key: string) => fields[key] ?? '').trim()]
    : [
        context.handoff.title,
        `From: ${fm.source.project}${fm.source.branch ? ` (${fm.source.branch})` : ''}`,
        `For: ${fm.targets.join(', ') || 'any consumer'}${fm.breaking ? ' · BREAKING CHANGE' : ''}`,
      ];
  if (summary && !template?.includes('{summary}')) lines.push('', truncate(summary, 600));
  if (actions) lines.push('', 'Required actions:', truncate(actions, 900));
  const preview = truncate(lines.join('\n'), 1400);
  // A link must survive preview truncation in full, including a custom template.
  return shareUrl && !preview.includes(shareUrl) ? `${preview}\n\nFull handoff: ${shareUrl}` : preview;
}

/** A `mailto:` draft. The portable scheme cannot attach a Markdown file. */
export const emailChannel: HandoffChannel = {
  id: 'email',
  kind: 'compose',
  description: 'Prepare an email draft and export the handoff for manual attachment.',
  isAvailable: () => true,
  async send(context: SendContext): Promise<SendResult> {
    const to = (context.destination ?? context.settings?.to ?? '').trim();
    const subject = `Handoff: ${context.handoff.title}`;
    const link = await shareLink(context);
    const body = emailBody(context, link.url);
    const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    const exportedPath = link.url ? undefined : namedCopy(context);
    if (!link.url && !exportedPath) {
      return {
        ok: false,
        destination: to || 'email',
        message: 'Could not export the Markdown handoff. No email draft was opened; choose a writable outbox and try again.',
      };
    }
    const recipient = to ? '' : 'Choose a recipient. ';
    const nextStep = link.url
      ? `${recipient}Review the draft, then press send.`
      : `No file is attached automatically. ${stageAttachment(context, exportedPath ?? undefined)} ${recipient}Review the draft, then press send.`;
    const opened = context.open === false ? { ok: false } : openExternal(url);
    const trouble = link.error ? ` (no link: ${link.error})` : '';

    const result: SendResult = {
      ok: true,
      destination: to || 'email',
      url,
      nextStep,
      composed: true,
      opened: opened.ok,
      message: opened.ok
        ? `Opened a draft${to ? ` to ${to}` : ''}.${trouble} ${nextStep}`
        : `Open this to compose: ${url}${trouble}\n${nextStep}`,
    };
    if (exportedPath) result.exportedPath = exportedPath;
    if (link.url) result.shareUrl = link.url;
    if (link.visibility) result.shareVisibility = link.visibility;
    if (link.uploaded) result.uploaded = link.uploaded;
    return result;
  },
};
