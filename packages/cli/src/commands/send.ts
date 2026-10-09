import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  channelWithSettings,
  configProblems,
  deliveryOptions,
  findSecrets,
  formatDeliveryOptions,
  handoffDirectory,
  HandoffStore,
  loadConfig,
  validateHandoff,
} from 'ryujin-handoff-core';
import { boolOption, stringOption, UsageError, type OptionSpec, type ParsedArgs } from '../args.ts';
import { err, out, style } from '../ui.ts';

export const sendOptions: Record<string, OptionSpec> = {
  channel: {
    type: 'string',
    short: 'c',
    describe: 'Where to send it (handoff send --list shows what is set up)',
    placeholder: '<id>',
  },
  to: {
    type: 'string',
    describe: 'Destination: a path, a phone number, an address',
    placeholder: '<where>',
  },
  list: { type: 'boolean', describe: 'Show the delivery routes for this handoff and stop' },
  link: {
    type: 'string',
    describe:
      'repo = link to it in your repository (private stays private); gist = upload a secret gist, readable by anyone with the URL; none = attach the file yourself',
    placeholder: '<repo|gist|none>',
  },
  'no-open': {
    type: 'boolean',
    describe: 'Print the link instead of opening it, and leave the clipboard alone',
  },
  force: { type: 'boolean', describe: 'Send even when validation fails' },
};

/**
 * Move a handoff somewhere a teammate can get at it.
 *
 * All three built-in channels are local. That is not a placeholder for "real" integrations
 * — a Markdown file already travels perfectly well through Slack, email and pull requests,
 * and a tool that promises never to upload your code should not quietly grow a network
 * client to save one paste.
 */
/** Validate the `--link` argument without letting an unknown value pass silently. */
function linkMode(value: string | undefined): { link?: 'repo' | 'gist' | 'none' } {
  if (value === undefined) return {};
  if (value === 'repo' || value === 'gist' || value === 'none') return { link: value };
  throw new UsageError(`--link must be repo, gist or none, got "${value}"`);
}

export async function sendCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const ref = args.positionals[0];
  const loaded = loadConfig(cwd);
  if (!ref && boolOption(args, 'list')) {
    // Without a handoff there are no targets to route by, but what is set up still is.
    out(formatDeliveryOptions(deliveryOptions(loaded.config, [])));
    for (const problem of configProblems(loaded.config)) err(`${style.yellow('config')} ${problem}`);
    return 0;
  }
  if (!ref) {
    err('Usage: handoff send <id> [--channel <id>] [--to <where>] [--link repo|gist|none] [--list] [--no-open]');
    return 1;
  }

  const store = new HandoffStore(handoffDirectory(loaded));
  const found = store.resolveRef(ref, cwd);
  if (!found) {
    err(`No handoff matching "${ref}".`);
    return 1;
  }

  const options = deliveryOptions(loaded.config, found.handoff.frontmatter.targets);
  const problems = configProblems(loaded.config);
  if (boolOption(args, 'list')) {
    out(formatDeliveryOptions(options));
    for (const problem of problems) err(`${style.yellow('config')} ${problem}`);
    return 0;
  }

  // Default to whatever this project routed to the target, falling back to the clipboard.
  const routed = options.find((option) => option.routed && option.available);
  const channelId = stringOption(args, 'channel') ?? routed?.id ?? 'clipboard';

  const resolved = channelWithSettings(loaded.config, channelId);
  if (!resolved) {
    err(`Unknown channel "${channelId}".`);
    err(`Run ${style.cyan('handoff send ' + found.id + ' --list')} to see what is available.`);
    return 1;
  }
  const { channel, settings } = resolved;
  if (!channel.isAvailable(settings)) {
    const option = options.find((entry) => entry.id === channelId);
    err(`Channel "${channelId}" is not usable here: ${option?.blockedBy ?? 'unavailable'}.`);
    return 1;
  }

  const markdown = readFileSync(found.path, 'utf8');
  const validation = validateHandoff(found.handoff);
  const secrets = findSecrets(markdown);

  if (secrets.length > 0 && !boolOption(args, 'force')) {
    for (const finding of secrets) {
      err(`${style.red('secret')} line ${finding.line}: possible ${finding.kind} (${finding.preview})`);
    }
    err('Refusing to send. Remove the credential, or pass --force if this is a false positive.');
    return 1;
  }

  if (!validation.ok && !boolOption(args, 'force')) {
    for (const issue of validation.errors) err(`${style.red('error')} ${issue.message}`);
    err('Refusing to send an invalid handoff. Fix it, or pass --force.');
    return 1;
  }
  // A scaffold is valid as a draft, and still not something to hand a teammate: it is the
  // template the agent was meant to fill in, and sending it is the failure this project
  // exists to prevent.
  const scaffold = validation.warnings.find((issue) => issue.code === 'unfilled-template');
  if (scaffold && !boolOption(args, 'force')) {
    err(`${style.red('error')} ${scaffold.message}`);
    err('Refusing to send a scaffold. Have your agent finish it, or pass --force.');
    return 1;
  }
  if (found.handoff.frontmatter.status === 'draft' && !boolOption(args, 'force')) {
    err(`${style.yellow('warn')} this handoff is still \`status: draft\`. Sending anyway.`);
  }
  for (const problem of problems) err(`${style.yellow('config')} ${problem}`);

  const destination = stringOption(args, 'to');
  const result = await channel.send({
    markdown,
    handoff: found.handoff,
    sourcePath: found.path,
    cwd,
    settings,
    open: !boolOption(args, 'no-open'),
    stagingDir: join(handoffDirectory(loaded), 'outbox'),
    ...linkMode(stringOption(args, 'link')),
    ...(destination !== undefined ? { destination } : {}),
  });

  if (!result.ok) {
    err(`${style.red('failed')} ${result.message}`);
    return 1;
  }
  // A compose channel opened an app; nothing has left the machine until the developer
  // presses send there, so "sent" would be a claim about something that has not happened.
  const verb =
    result.composed || channel.kind === 'compose'
      ? result.opened
        ? 'opened'
        : 'ready'
      : channel.kind === 'local'
        ? 'done'
        : 'sent';
  if (result.message) out(`${style.green(verb)} ${result.message}`);
  if (result.uploaded) out(style.yellow(`  uploaded to ${result.uploaded} to make the link`));
  if (result.shareUrl) {
    out(style.dim(`  link in the message: ${result.shareUrl}`));
    // Never let a developer guess who can read what they just sent.
    if (result.shareVisibility) out(style.dim(`  readable by: ${result.shareVisibility}`));
  }
  return 0;
}
