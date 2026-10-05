/**
 * How a project delivers handoffs, and to whom.
 *
 * Kept separate from the channel implementations because this is *policy* — which team
 * gets reached how — and a team should be able to read it without reading any code.
 */

export interface ChannelSettings {
  /** Slack or Discord incoming webhook URL. */
  webhook?: string;
  /** Default recipient: a phone number for WhatsApp, an address for email. */
  to?: string;
  /** Human label shown when offering the route, e.g. "#infra". */
  label?: string;
  /**
   * How a compose channel gets the document to the reader.
   *
   * - `repo` links to the handoff where it is already committed. Readable by whoever can
   *   read the repository and by nobody else, so a private repo stays private. Nothing is
   *   uploaded. Requires the handoff to be pushed.
   * - `gist` uploads a secret gist. "Secret" is unlisted, not private: anyone who comes by
   *   the URL can read it.
   * - `none` means the developer attaches the file, and the message says so rather than
   *   claiming an attachment that is not there.
   */
  link?: 'repo' | 'gist' | 'none';
  /**
   * Wording for the opening line of a chat or mail message, replacing the default.
   * `{title}`, `{who}`, `{summary}` and `{url}` are filled in; the link is never shortened.
   */
  template?: string;
  /**
   * Environment variables this channel's settings refer to that are not set. Filled in by
   * {@link resolveChannelSettings}; a value that still reads `${VAR}` is not a setting.
   */
  unresolved?: string[];
}

export type ChannelSettingsMap = Record<string, ChannelSettings>;

/** Which channels reach which consumer. `default` applies when a target has no entry. */
export type RouteMap = Record<string, string[]>;

/**
 * Expand `${ENV_VAR}` in a configured value.
 *
 * Webhook URLs are credentials: anyone holding one can post into the channel. A committed
 * `handoff.config.json` is the wrong place for one, so the indirection exists to make the
 * right thing easy — and {@link literalSecrets} complains when it was not used.
 */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    const resolved = env[name];
    return resolved === undefined ? whole : resolved;
  });
}

/** True when the value still contains an unresolved `${VAR}`. */
export function hasUnresolvedEnv(value: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value);
}

/** The names of the `${VAR}` references in a value. */
function envNames(value: string): string[] {
  return [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1] ?? '');
}

/**
 * Settings with `${ENV}` expanded.
 *
 * A value whose variable is not set is dropped rather than passed on as the literal text
 * `${SLACK_WEBHOOK}`: that string is not a webhook, and treating it as one made a channel
 * look configured and then fail with a reason that had nothing to do with the problem.
 * The missing names are kept in `unresolved` so the developer is told what to set.
 */
export function resolveChannelSettings(
  settings: ChannelSettings,
  env: NodeJS.ProcessEnv = process.env,
): ChannelSettings {
  const resolved: ChannelSettings = {};
  const unresolved: string[] = [];
  const expand = (value: string): string | undefined => {
    const expanded = expandEnv(value, env);
    if (!hasUnresolvedEnv(expanded)) return expanded;
    unresolved.push(...envNames(expanded));
    return undefined;
  };

  const webhook = settings.webhook ? expand(settings.webhook) : undefined;
  if (webhook) resolved.webhook = webhook;
  const to = settings.to ? expand(settings.to) : undefined;
  if (to) resolved.to = to;
  if (settings.label) resolved.label = settings.label;
  if (settings.link) resolved.link = settings.link;
  if (settings.template) resolved.template = settings.template;
  if (unresolved.length > 0) resolved.unresolved = [...new Set(unresolved)];
  return resolved;
}

/**
 * Webhook URLs written literally into the config rather than through an environment
 * variable. Reported so a developer finds out before the file is committed, not after.
 */
export function literalSecrets(channels: ChannelSettingsMap): string[] {
  const found: string[] = [];
  for (const [id, settings] of Object.entries(channels)) {
    const webhook = settings.webhook;
    if (webhook && !hasUnresolvedEnv(webhook) && /^https?:\/\//.test(webhook)) {
      found.push(id);
    }
  }
  return found;
}

/** Channels configured for a target, falling back to the `default` route. */
export function routesFor(
  routes: RouteMap,
  channels: ChannelSettingsMap,
  targets: readonly string[],
): string[] {
  const wanted = new Set<string>();
  for (const target of targets) {
    for (const id of routes[target] ?? []) wanted.add(id);
  }
  if (wanted.size === 0) {
    for (const id of routes['default'] ?? []) wanted.add(id);
  }
  // A route naming a channel with no settings is a configuration mistake, not a route.
  return [...wanted].filter((id) => channels[id] !== undefined || !needsSettings(id));
}

/**
 * Channels that work with no configuration at all.
 *
 * WhatsApp and email are here because they compose: with nothing configured they open
 * the app and the developer picks the recipient. Leaving them out made a route such as
 * `"mobile": ["whatsapp"]` disappear whenever `channels.whatsapp` was absent.
 */
export function needsSettings(id: string): boolean {
  return !['clipboard', 'file', 'stdout', 'text', 'github', 'whatsapp', 'email'].includes(id);
}
