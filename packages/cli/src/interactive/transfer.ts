import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { handoffDirectory, isSupportedHandoff, loadConfig, readTextIfExists } from 'agents-handoff-core';
import type { ParsedArgs } from '../args.ts';
import { select, text, type Choice } from '../prompt/index.ts';
import { err, out, style } from '../ui.ts';
import { receiveCommand } from '../commands/receive.ts';
import { sendCommand } from '../commands/send.ts';
import { pickChannel, pickHandoff, pickReceivingTarget } from './pick.ts';

const TYPE_A_PATH = ' type-a-path';

/** Walk a developer through sending a handoff they already created. */
export async function interactiveSend(cwd: string): Promise<number> {
  const entry = await pickHandoff(cwd, 'outgoing', 'Which handoff do you want to send?');
  if (!entry) {
    out(style.dim('No handoffs here yet.'));
    out(`Create one with ${style.cyan('handoff create')}.`);
    return 0;
  }

  const channel = await pickChannel(loadConfig(cwd).config, entry.handoff.frontmatter.targets);
  const values: ParsedArgs['values'] = { channel };
  if (channel === 'file') {
    values['to'] = await text({
      message: 'Write it where?',
      default: relative(cwd, join(handoffDirectory(loadConfig(cwd)), 'outbox')),
      validate: (value) => (value.trim() ? null : 'give it a path'),
    });
  }
  return sendCommand({ values, positionals: [entry.id] }, cwd);
}

/**
 * Walk a developer through reading a handoff someone sent them.
 *
 * Candidate files are offered rather than demanded, because the usual state at this moment
 * is "a colleague just sent me a file and I do not remember where it landed".
 */
export async function interactiveReceive(cwd: string): Promise<number> {
  const loaded = loadConfig(cwd);
  const candidates = findCandidates(cwd);

  let path: string;
  if (candidates.length > 0) {
    const choices: Array<Choice<string>> = candidates.map((file) => ({
      value: file,
      label: relative(cwd, file) || file,
    }));
    choices.push({ value: TYPE_A_PATH, label: 'somewhere else…', hint: 'type a path' });
    const chosen = await select<string>({ message: 'Which file did they send you?', choices });
    path = chosen === TYPE_A_PATH ? await askPath(cwd) : chosen;
  } else {
    out(style.dim('No handoff files found nearby.'));
    path = await askPath(cwd);
  }

  const as = await pickReceivingTarget(loaded.config);
  const values: ParsedArgs['values'] = {};
  if (as) values['as'] = as;
  return receiveCommand({ values, positionals: [path] }, cwd);
}

async function askPath(cwd: string): Promise<string> {
  return text({
    message: 'Path to the handoff:',
    placeholder: '~/Downloads/HANDOFF.md',
    validate: (value) => {
      if (!value.trim()) return 'give it a path';
      const resolved = join(cwd, value);
      if (!existsSync(value) && !existsSync(resolved)) return `cannot find ${value}`;
      return null;
    },
  });
}

/**
 * Markdown files near the working directory that actually parse as v1 handoffs.
 *
 * Reading each candidate is cheap and stops the list filling up with every README and
 * changelog in the project.
 */
export function findCandidates(cwd: string, limit = 8): string[] {
  const roots = [cwd, join(cwd, 'Downloads'), join(handoffDirectory(loadConfig(cwd)), 'inbox')];
  const found: string[] = [];

  for (const root of roots) {
    if (found.length >= limit) break;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (found.length >= limit) break;
      const full = join(root, name);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      // The inbox stores one directory per handoff.
      if (stats.isDirectory()) {
        const nested = join(full, 'HANDOFF.md');
        if (existsSync(nested) && looksLikeHandoff(nested)) found.push(nested);
        continue;
      }
      if (!name.toLowerCase().endsWith('.md')) continue;
      if (looksLikeHandoff(full)) found.push(full);
    }
  }
  return [...new Set(found)];
}

function looksLikeHandoff(path: string): boolean {
  const source = readTextIfExists(path);
  return source !== null && isSupportedHandoff(source);
}

/** Report a missing path the same way whichever route got here. */
export function reportMissing(path: string): number {
  err(`${style.red('error')} cannot read ${path}`);
  return 1;
}
