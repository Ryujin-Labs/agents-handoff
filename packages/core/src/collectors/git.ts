import { commitRange } from '../git/index.ts';
import { truncate } from '../util/text.ts';
import type { Collector, CollectorResult } from './types.ts';

/**
 * The baseline collector: what the revision is, which commits it contains, and how big it
 * is. Everything else in the brief is an interpretation of this.
 */
export const gitCollector: Collector = {
  name: 'git',
  description: 'Revision range, commits, changed files and diff size.',
  collect(context): CollectorResult {
    const { git, revision, changedFiles, config } = context;
    // A working-tree or staged revision contains no commits. `git log HEAD` would happily
    // return the last N commits of history, which are not part of the change and would
    // send the reader off describing work that shipped weeks ago.
    const commits =
      revision.includesWorkingTree || !revision.spec
        ? []
        : git.commits(commitRange(revision), config.context.maxCommits);
    const additions = changedFiles.reduce((sum, file) => sum + file.additions, 0);
    const deletions = changedFiles.reduce((sum, file) => sum + file.deletions, 0);

    const facts: Array<{ label: string; value: string }> = [
      { label: 'revision', value: `${revision.spec || 'working tree'} (${revision.description})` },
      {
        label: 'scope',
        value: `${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'}, +${additions} / -${deletions}`,
      },
    ];

    if (commits.length > 0) {
      facts.push({
        label: 'commits',
        value: commits
          .map((commit) => `${commit.shortHash} ${truncate(commit.subject, 72)}`)
          .join('\n'),
      });
      const authors = [...new Set(commits.map((commit) => commit.author))];
      if (authors.length > 0) facts.push({ label: 'authors', value: authors.join(', ') });
    }

    return {
      name: 'git',
      summary: summarize(changedFiles.length, commits.length, revision.includesWorkingTree),
      signals: [],
      suggestedReading: [],
      facts,
    };
  },
};

function summarize(fileCount: number, commitCount: number, workingTree: boolean): string {
  if (fileCount === 0) return 'No changed files in this revision.';
  const files = `${fileCount} changed file${fileCount === 1 ? '' : 's'}`;
  if (workingTree) return `${files}, not yet committed.`;
  if (commitCount === 0) return `${files}.`;
  return `${files} across ${commitCount} commit${commitCount === 1 ? '' : 's'}.`;
}
