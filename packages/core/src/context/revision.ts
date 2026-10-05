import type { Git, Revision } from '../git/index.ts';

export interface RevisionRequest {
  /** Explicit base ref, e.g. `main` or `v2.1.0`. */
  base?: string | undefined;
  /** Number of trailing commits, e.g. `5` for `HEAD~5..HEAD`. */
  commits?: number | undefined;
  /** Git date expression, e.g. `2 weeks ago`. */
  since?: string | undefined;
  /** Diff only staged changes. */
  staged?: boolean | undefined;
  /** Diff only uncommitted working-tree changes. */
  working?: boolean | undefined;
  /**
   * Restrict the change to these paths.
   *
   * A working tree usually holds more than one piece of work. Without this, a handoff
   * about the deploy script also carries whatever else happened to be uncommitted, and
   * the reader has to guess which half concerns them.
   */
  paths?: string[] | undefined;
  /**
   * Uncommitted paths that do not make the working tree "dirty" when choosing the default
   * revision: this tool's own files and build output. Without it, writing one handoff on
   * trunk turned the next brief into an empty working tree instead of the commit.
   */
  ignore?: ((path: string) => boolean) | undefined;
}

/**
 * Choose the revision a handoff describes.
 *
 * The default is deliberately "this branch since it forked from trunk", because that is
 * what a developer means by "the work I just finished". The explicit options exist for the
 * historical case: describing something that shipped last month.
 */
export function resolveRevision(git: Git, request: RevisionRequest): Revision {
  // Scoping is applied once, here, rather than at each return below. Threading it through
  // every branch is exactly the kind of thing that silently misses one.
  const chosen = chooseRevision(git, request);
  if (!request.paths?.length) return chosen;
  return {
    ...chosen,
    paths: request.paths,
    description: `${chosen.description}, limited to ${describePaths(request.paths)}`,
  };
}

function describePaths(paths: readonly string[]): string {
  return paths.length === 1 ? (paths[0] ?? '') : `${paths.length} paths`;
}

function chooseRevision(git: Git, request: RevisionRequest): Revision {
  if (request.working) {
    return {
      spec: 'HEAD',
      description: 'uncommitted working-tree changes',
      includesWorkingTree: true,
    };
  }
  if (request.staged) {
    return { spec: '--cached', description: 'staged changes', includesWorkingTree: true };
  }
  if (request.since) {
    const sinceCommit = firstCommitSince(git, request.since);
    if (!sinceCommit) {
      // An empty window has to stay empty. `HEAD` would quietly substitute the uncommitted
      // working tree for the committed history the developer asked about, and calling that
      // commit-based would let `git log HEAD` present all of history as the change.
      return {
        spec: 'HEAD..HEAD',
        description: `no commits since ${request.since}`,
        includesWorkingTree: false,
      };
    }
    const description = `commits since ${request.since}`;
    // `<commit>^` does not exist once the window reaches back to the root commit, and a
    // ref git cannot resolve makes the whole diff fail rather than come back empty.
    const parent = git.resolve(`${sinceCommit}^`);
    if (parent) return { spec: `${parent}..HEAD`, description, includesWorkingTree: false };
    // Nothing precedes the root commit but the empty tree. That is a tree, not a commit,
    // so the log side cannot use the same range: all of history is in the window anyway.
    const emptyTree = git.emptyTree();
    return {
      spec: emptyTree ? `${emptyTree}..HEAD` : `${sinceCommit}..HEAD`,
      logSpec: 'HEAD',
      description,
      includesWorkingTree: false,
    };
  }
  if (request.commits && request.commits > 0) {
    return lastCommits(git, request.commits, `last ${request.commits} commit${request.commits === 1 ? '' : 's'}`);
  }
  if (request.base) {
    return baseRevision(git, request.base);
  }

  const base = git.defaultBaseRef();
  if (base && git.resolve(base) !== git.resolve('HEAD')) {
    const revision = baseRevision(git, base);
    // On trunk itself the branch diff is empty, which is never what the developer meant.
    const probe = request.paths?.length ? { ...revision, paths: request.paths } : revision;
    if (git.changedFiles(probe).length > 0) return revision;
  }

  const ignore = request.ignore;
  const dirty = ignore ? git.uncommittedPaths().some((path) => !ignore(path)) : git.isDirty();
  if (dirty) {
    return {
      spec: 'HEAD',
      description: 'uncommitted working-tree changes',
      includesWorkingTree: true,
    };
  }
  return lastCommits(git, 1, 'the most recent commit');
}

/**
 * The last `count` commits. On a short history `HEAD~count` does not exist — a repository
 * with one commit has no `HEAD~1` — and a ref git cannot resolve fails the whole diff, so
 * the brief came back empty for exactly the brand-new project a developer tries first.
 * Past the root, the range starts from the empty tree: all of history is the change.
 */
function lastCommits(git: Git, count: number, description: string): Revision {
  if (git.resolve(`HEAD~${count}`)) {
    return { spec: `HEAD~${count}..HEAD`, description, includesWorkingTree: false };
  }
  const emptyTree = git.emptyTree();
  return {
    spec: emptyTree ? `${emptyTree}..HEAD` : 'HEAD..HEAD',
    logSpec: 'HEAD',
    description: `${description} (the whole history, which is shorter than that)`,
    includesWorkingTree: false,
  };
}

function baseRevision(git: Git, base: string): Revision {
  if (!git.resolve(base)) {
    return lastCommits(git, 1, `base "${base}" not found; using the most recent commit`);
  }
  // Three-dot diff compares against the merge base, which is what "since I branched off"
  // means. Falling back to two dots keeps unrelated histories working.
  const spec = git.mergeBase(base, 'HEAD') ? `${base}...HEAD` : `${base}..HEAD`;
  return {
    spec,
    // `git log` reads three dots as the symmetric difference, so it would also list every
    // commit that landed on the base after the fork — other people's trunk work, credited
    // to this handoff and contradicting the diff printed beside it.
    logSpec: `${base}..HEAD`,
    description: `changes on this branch since ${base}`,
    includesWorkingTree: false,
  };
}

function firstCommitSince(git: Git, since: string): string | null {
  const commits = git.logForPaths(['.'], 1000, since);
  return commits.at(-1)?.hash ?? null;
}
