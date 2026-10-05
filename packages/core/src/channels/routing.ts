import {
  literalSecrets,
  needsSettings,
  resolveChannelSettings,
  routesFor,
  type ChannelSettings,
} from '../config/channels.ts';
import type { HandoffConfig } from '../config/index.ts';
import { BUILTIN_CHANNELS, findChannel } from './index.ts';
import type { ChannelKind, HandoffChannel } from './types.ts';

export interface DeliveryOption {
  id: string;
  kind: ChannelKind;
  description: string;
  /** Human label for the destination, when one is configured. */
  label?: string;
  /** True when this channel is routed to the target under discussion. */
  routed: boolean;
  /** False when it cannot run here or is missing configuration. */
  available: boolean;
  /** Why it is unavailable, phrased so a developer can fix it. */
  blockedBy?: string;
  /**
   * What this channel uploads on the way, as configured — a secret gist for `link: gist`.
   * Stated up front, because "opens the app, you press send" is otherwise true and the
   * upload would be news only after it happened.
   */
  uploads?: string;
}

/**
 * Every way this handoff could be delivered, and which are actually set up.
 *
 * The point is to let an agent answer "where should I send this?" with something specific
 * rather than a shrug. Routed channels come first because they are what this project
 * decided reaches this team; the rest follow so the answer is never "nowhere".
 */
export function deliveryOptions(
  config: HandoffConfig,
  targets: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): DeliveryOption[] {
  const routed = new Set(routesFor(config.routes, config.channels, targets));

  const options = BUILTIN_CHANNELS.map((channel) =>
    describe(channel, settingsFor(config, channel.id, env), routed.has(channel.id)),
  );

  // Routed first, then whatever else works, then the blocked ones with a reason.
  return options.sort((a, b) => {
    if (a.routed !== b.routed) return a.routed ? -1 : 1;
    if (a.available !== b.available) return a.available ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

function describe(
  channel: HandoffChannel,
  settings: ChannelSettings | undefined,
  routed: boolean,
): DeliveryOption {
  const available = channel.isAvailable(settings);
  const option: DeliveryOption = {
    id: channel.id,
    kind: channel.kind,
    description: channel.description,
    routed,
    available,
  };
  if (settings?.label) option.label = settings.label;
  if (settings?.link === 'gist' && channel.id !== 'github') {
    option.uploads = 'a secret gist first — readable by anyone with the link';
  }
  if (!available) {
    option.blockedBy = settings?.unresolved?.length
      ? `set ${settings.unresolved.join(', ')} in your environment`
      : channel.requires
        ? `needs ${channel.requires}`
        : 'not available on this machine';
  }
  return option;
}

/**
 * Everything wrong with how this project is configured to deliver, in plain sentences.
 *
 * Each of these used to fail silently: a route naming a channel that does not exist was
 * dropped, a route to a channel with no settings was dropped, and a webhook written
 * straight into a file that gets committed went unmentioned until it had leaked.
 */
export function configProblems(
  config: HandoffConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const problems: string[] = [];

  for (const [target, ids] of Object.entries(config.routes)) {
    for (const id of ids) {
      if (!findChannel(id)) {
        problems.push(`routes.${target} names "${id}", which is not a channel.`);
      } else if (needsSettings(id) && config.channels[id] === undefined) {
        problems.push(`routes.${target} names "${id}", but channels.${id} is not configured, so the route is ignored.`);
      }
    }
  }

  for (const [id, raw] of Object.entries(config.channels)) {
    const unresolved = resolveChannelSettings(raw, env).unresolved;
    if (unresolved?.length) {
      problems.push(`channels.${id} refers to ${unresolved.map((name) => `$\{${name}\}`).join(', ')}, which is not set in this environment.`);
    }
  }

  for (const id of literalSecrets(config.channels)) {
    problems.push(
      `channels.${id}.webhook is written into handoff.config.json. Anyone who can read that file can post with it — move it to an environment variable and write \${VARIABLE} instead.`,
    );
  }

  return problems;
}

/** Configured settings for a channel, with `${ENV}` expanded. */
export function settingsFor(
  config: HandoffConfig,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): ChannelSettings | undefined {
  const raw = config.channels[id];
  return raw ? resolveChannelSettings(raw, env) : undefined;
}

/** Resolve a channel and its settings together, for a send. */
export function channelWithSettings(
  config: HandoffConfig,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): { channel: HandoffChannel; settings: ChannelSettings | undefined } | null {
  const channel = findChannel(id);
  if (!channel) return null;
  return { channel, settings: settingsFor(config, id, env) };
}

/** One line per option, for a terminal or a tool result. */
export function formatDeliveryOptions(options: readonly DeliveryOption[]): string {
  return options
    .map((option) => {
      const marks = [
        option.routed ? 'routed' : '',
        option.kind === 'compose' ? 'opens the app, you press send' : '',
        option.uploads ? `uploads ${option.uploads}` : '',
        option.available ? '' : (option.blockedBy ?? 'unavailable'),
      ].filter(Boolean);
      const where = option.label ? ` → ${option.label}` : '';
      return `${option.id.padEnd(10)}${where}  ${option.description}${marks.length ? `  [${marks.join(' · ')}]` : ''}`;
    })
    .join('\n');
}
