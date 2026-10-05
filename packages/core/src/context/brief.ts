import type { Signal } from '../collectors/types.ts';
import { markdownTable, tidyMarkdown, truncate, unique } from '../util/text.ts';
import { breakingCandidates, inferChangeTypes, type ChangeContext } from './collect.ts';

const STATUS_SYMBOL: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  other: '?',
};

/**
 * Render the change context as Markdown for a coding agent to read.
 *
 * This document is not the handoff. It is the raw material: everything a machine could
 * work out on its own, arranged so that the expensive part (deciding what matters to
 * another team) is the only thing left to do.
 */
export function renderBrief(context: ChangeContext): string {
  const lines: string[] = [];

  lines.push('# Handoff Context Brief', '');
  lines.push(
    `Deterministically collected from the repository at ${context.generatedAt}. ` +
      'Nothing here has been interpreted by a model.',
    '',
  );

  if (context.warnings.length > 0) {
    lines.push('## Warnings', '');
    for (const warning of context.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  lines.push('## Repository', '');
  const repo = context.repo;
  lines.push(...bullets([
    ['project', context.project],
    ['root', context.root],
    ['branch', repo?.branch ?? 'unknown'],
    ['head', repo?.head ? `${repo.head.shortHash} ${truncate(repo.head.subject, 70)}` : 'none'],
    ['remote', repo?.slug ?? repo?.remoteUrl ?? 'none'],
    ['working tree', repo?.dirty ? 'has uncommitted changes' : 'clean'],
    ['revision', `${context.revision.spec || 'working tree'} — ${context.revision.description}`],
  ]));
  lines.push('');

  lines.push('## Request', '');
  if (context.targets.length > 0) lines.push(`- targets: ${context.targets.join(', ')}`);
  if (context.note) lines.push(`- developer note: ${context.note}`);
  lines.push(
    context.language
      ? `- language: write the prose in ${context.language} (set in handoff.config.json). Section headings stay in English.`
      : '- language: write the prose in English. Do not infer another language from the repository, even if its other documents use one.',
  );
  lines.push(`- when to ask: ${askGuidance(context.ask)}`);
  lines.push(
    context.routes.length > 0
      ? `- delivery routes configured for this target: ${context.routes.join(', ')}. Offer one when you report back; never send without being asked.`
      : '- delivery: no routes configured for this target. Say how they can send the file, and that routes can be configured once.',
  );
  lines.push('');

  if (context.existing.length > 0) {
    lines.push('## Handoffs already written here', '');
    for (const entry of context.existing) {
      lines.push(
        `- \`${entry.id}\` — ${entry.title} (${entry.createdAt.slice(0, 10)}, for ${entry.targets.join(', ') || 'any consumer'}, ${entry.status})`,
      );
    }
    lines.push(
      '',
      'If one of these describes this change, do not decide for the developer: ask whether to update it or write a new one beside it — it may already have been sent. Update means `handoff_write` with its `id` and `overwrite: true`.',
      '',
    );
  }

  lines.push(...renderChangedFiles(context));
  lines.push(...renderSignals(context));
  lines.push(...renderCollectors(context));
  lines.push(...renderReading(context));
  lines.push(...renderNextStep(context));

  return tidyMarkdown(lines.join('\n'));
}

function askGuidance(policy: ChangeContext['ask']): string {
  switch (policy) {
    case 'always':
      return 'confirm the target, the scope and the breaking call with the developer before writing.';
    case 'never':
      return 'decide everything yourself; the developer does not want to be asked.';
    default:
      return 'decide what you can, and ask only when a different answer would produce a materially different document — a mixed working tree, a guessed target, an unsettled breaking call.';
  }
}

/** Render `label: value` pairs, dropping the ones with nothing to say. */
function bullets(pairs: Array<[string, string]>): string[] {
  return pairs
    .filter(([, value]) => value && value !== 'none' && value !== 'unknown')
    .map(([label, value]) => `- ${label}: ${value}`);
}

function renderChangedFiles(context: ChangeContext): string[] {
  if (context.changedFiles.length === 0) return [];
  const lines = ['## Changed files', ''];
  const additions = context.changedFiles.reduce((sum, file) => sum + file.additions, 0);
  const deletions = context.changedFiles.reduce((sum, file) => sum + file.deletions, 0);
  lines.push(
    `${context.changedFiles.length} file(s), +${additions} / -${deletions}.`,
    '',
    markdownTable(
      ['', 'file', 'lines'],
      context.changedFiles.map((file) => [
        STATUS_SYMBOL[file.status] ?? '?',
        file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path,
        file.binary ? 'binary' : `+${file.additions}/-${file.deletions}`,
      ]),
    ),
    '',
  );
  if (context.ignoredFiles.length > 0) {
    lines.push(
      `Excluded as build output or vendored code: ${context.ignoredFiles.length} file(s).`,
      '',
    );
  }
  return lines;
}

function renderSignals(context: ChangeContext): string[] {
  const candidates = breakingCandidates(context);
  if (candidates.length === 0) return [];
  const lines = ['## Possible breaking changes', ''];
  lines.push(
    'Pattern matches only. Each one is a question for you to answer from the code, not a',
    'conclusion. Confirm or discard every entry before writing `breaking: true`.',
    '',
  );
  lines.push(...signalList(candidates));
  lines.push('');
  return lines;
}

function renderCollectors(context: ChangeContext): string[] {
  const lines: string[] = [];
  for (const result of context.results) {
    const interesting = result.signals.filter((signal) => signal.kind !== 'breaking-candidate');
    if (!result.summary && interesting.length === 0 && result.facts.length === 0) continue;

    lines.push(`## ${titleFor(result.name)}`, '');
    if (result.summary) lines.push(result.summary, '');
    for (const fact of result.facts) {
      if (fact.value.includes('\n')) {
        lines.push(`${fact.label}:`, '');
        for (const value of fact.value.split('\n')) lines.push(`- ${value}`);
        lines.push('');
      } else {
        lines.push(`- ${fact.label}: ${fact.value}`);
      }
    }
    if (result.facts.some((fact) => !fact.value.includes('\n'))) lines.push('');
    if (interesting.length > 0) {
      lines.push(...signalList(interesting));
      lines.push('');
    }
  }
  return lines;
}

function renderReading(context: ChangeContext): string[] {
  const reading = unique(context.results.flatMap((result) => result.suggestedReading));
  if (reading.length === 0) return [];
  return [
    '## Suggested reading',
    '',
    'The files most likely to contain the behavior a consumer must know about:',
    '',
    ...reading.slice(0, 15).map((path) => `- ${path}`),
    '',
  ];
}

function renderNextStep(context: ChangeContext): string[] {
  const inferred = inferChangeTypes(context);
  return [
    '## What this brief does not contain',
    '',
    'The reasoning. This brief says what moved; it does not say what it means to another',
    'team, which of these changes actually break a consumer, or what that consumer must do',
    'about it. That judgment is the handoff, and it is yours to write.',
    '',
    `Inferred \`change_type\` for the frontmatter (verify, do not trust): ${inferred.join(', ')}.`,
    '',
  ];
}

function signalList(signals: readonly Signal[]): string[] {
  const grouped = new Map<string, Signal[]>();
  for (const signal of signals) {
    const bucket = grouped.get(signal.kind) ?? [];
    bucket.push(signal);
    grouped.set(signal.kind, bucket);
  }
  const lines: string[] = [];
  for (const [kind, bucket] of grouped) {
    if (grouped.size > 1) lines.push(`${kind}:`);
    for (const signal of bucket) {
      const where = signal.file ? ` (${signal.file})` : '';
      lines.push(`- ${signal.message}${where}`);
      if (signal.evidence) lines.push(`  \`${signal.evidence.replace(/`/g, "'")}\``);
    }
  }
  return lines;
}

function titleFor(name: string): string {
  const titles: Record<string, string> = {
    git: 'Revision',
    api: 'API surface',
    auth: 'Authentication and authorization',
    contracts: 'Contracts and types',
    database: 'Database',
    environment: 'Environment',
    dependencies: 'Dependencies',
    infrastructure: 'Infrastructure and config',
    tests: 'Tests',
    'agent-context': 'Agent context',
  };
  return titles[name] ?? name;
}

/** JSON form of the brief, for agents and integrations that prefer structured input. */
export function briefToJson(context: ChangeContext): Record<string, unknown> {
  return {
    generated_at: context.generatedAt,
    project: context.project,
    root: context.root,
    repo: context.repo,
    revision: context.revision,
    targets: context.targets,
    note: context.note,
    language: context.language,
    ask: context.ask,
    routes: context.routes,
    warnings: context.warnings,
    existing_handoffs: context.existing.map((entry) => ({
      id: entry.id,
      title: entry.title,
      created_at: entry.createdAt,
      targets: entry.targets,
      status: entry.status,
    })),
    inferred_change_type: inferChangeTypes(context),
    changed_files: context.changedFiles,
    ignored_files: context.ignoredFiles,
    breaking_candidates: breakingCandidates(context),
    collectors: context.results,
  };
}
