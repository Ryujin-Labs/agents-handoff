import { Git, loadConfig, revisionFor, type Revision } from 'agents-handoff-core';
import { select, text, type Choice } from '../prompt/index.ts';

/** The revision flags an interactive answer resolves to. */
export interface ScopeAnswer {
  base?: string;
  commits?: number;
  since?: string;
  staged?: boolean;
  working?: boolean;
}

type ScopeKind = 'branch' | 'working' | 'staged' | 'commits' | 'since';

/**
 * Ask what the handoff should cover.
 *
 * Each option is priced before it is offered: the file count comes from the same git calls
 * the collectors would make. An option that would produce an empty handoff is dropped
 * rather than shown and then disappointing someone.
 */
export async function pickScope(cwd: string): Promise<ScopeAnswer> {
  const git = new Git(cwd);
  const choices: Array<Choice<ScopeKind>> = [];

  const base = git.defaultBaseRef();
  if (base && git.resolve(base) !== git.resolve('HEAD')) {
    const count = countFor(git, { spec: `${base}...HEAD`, description: '', includesWorkingTree: false });
    if (count > 0) {
      choices.push({
        value: 'branch',
        label: `everything on this branch since ${base}`,
        hint: files(count),
      });
    }
  }

  if (git.isDirty()) {
    const working = countFor(git, { spec: 'HEAD', description: '', includesWorkingTree: true });
    if (working > 0) {
      choices.push({ value: 'working', label: 'my uncommitted changes', hint: files(working) });
    }
    const staged = countFor(git, { spec: '--cached', description: '', includesWorkingTree: true });
    if (staged > 0) {
      choices.push({ value: 'staged', label: 'only what I have staged', hint: files(staged) });
    }
  }

  choices.push({ value: 'commits', label: 'the last few commits', hint: 'you pick how many' });
  choices.push({ value: 'since', label: 'work from a while ago', hint: 'e.g. 3 weeks ago' });

  const kind = await select<ScopeKind>({ message: 'What should this handoff cover?', choices });

  switch (kind) {
    case 'branch':
      return base ? { base } : {};
    case 'working':
      return { working: true };
    case 'staged':
      return { staged: true };
    case 'commits': {
      const answer = await text({
        message: 'How many commits?',
        default: '5',
        validate: (value) =>
          /^\d+$/.test(value) && Number(value) > 0 ? null : 'a whole number greater than zero',
      });
      return { commits: Number(answer) };
    }
    case 'since': {
      const answer = await text({
        message: 'Since when?',
        default: '2 weeks ago',
        validate: (value) => (value.trim() ? null : 'try "3 weeks ago" or "2026-07-01"'),
      });
      return { since: answer };
    }
    default:
      return {};
  }
}

/** Human summary of what a scope answer resolves to, for a confirmation line. */
export function describeScope(cwd: string, answer: ScopeAnswer): string {
  const git = new Git(cwd);
  if (!git.isRepo()) return 'not a git repository';
  const revision = revisionFor(git, loadConfig(cwd), answer);
  const count = countFor(git, revision);
  return `${revision.description} — ${files(count)}`;
}

function countFor(git: Git, revision: Revision): number {
  return git.changedFiles(revision).length;
}

function files(count: number): string {
  return `${count} file${count === 1 ? '' : 's'}`;
}
