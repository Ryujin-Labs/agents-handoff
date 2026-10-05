import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { Git, commitRange, parseNumstatPath, repoSlug } from '../src/git/index.ts';
import { parseUnifiedDiff, trulyAdded, trulyRemoved } from '../src/collectors/diff.ts';
import { resolveRevision } from '../src/context/revision.ts';
import { commitAll, git as runGit, initRepo, removeDir, scenarioRepo, tempDir, writeFiles } from './helpers.ts';

const repo = scenarioRepo();
after(() => removeDir(repo));

describe('Git', () => {
  const git = new Git(repo);

  it('recognizes a repository and reports its branch and head', () => {
    assert.equal(git.isRepo(), true);
    assert.equal(git.branch(), 'feature/message-auth');
    assert.equal(git.hasCommits(), true);
    assert.match(git.info()?.head?.subject ?? '', /Require messages:write/);
  });

  it('reports a non-repository without throwing', () => {
    const dir = tempDir();
    try {
      const outside = new Git(dir);
      assert.equal(outside.isRepo(), false);
      assert.equal(outside.info(), null);
      assert.equal(outside.branch(), null);
    } finally {
      removeDir(dir);
    }
  });

  it('finds the trunk to compare against', () => {
    assert.equal(git.defaultBaseRef(), 'main');
  });

  it('resolves refs and returns null for ones that do not exist', () => {
    assert.ok(git.resolve('HEAD'));
    assert.equal(git.resolve('no-such-ref'), null);
  });

  it('lists changed files with line counts and statuses', () => {
    const revision = { spec: 'main...HEAD', description: 'test', includesWorkingTree: false };
    const files = git.changedFiles(revision);
    const paths = files.map((file) => file.path).sort();

    assert.deepEqual(paths, [
      'dist/bundle.js',
      'migrations/002_retention.sql',
      'src/auth/require-permission.ts',
      'src/routes/messages.ts',
      'types/message.ts',
    ]);
    assert.equal(files.find((file) => file.path === 'src/auth/require-permission.ts')?.status, 'added');
    assert.ok((files.find((file) => file.path === 'types/message.ts')?.deletions ?? 0) > 0);
  });

  it('detects a rename rather than reporting an add and a delete', () => {
    const dir = tempDir();
    try {
      initRepo(dir);
      writeFiles(dir, { 'a.txt': 'x'.repeat(200) });
      commitAll(dir, 'one');
      const local = new Git(dir);
      writeFiles(dir, { 'b.txt': 'x'.repeat(200) });
      runGit(dir, ['rm', '-q', 'a.txt']);
      commitAll(dir, 'two');

      const files = local.changedFiles({ spec: 'HEAD~1..HEAD', description: '', includesWorkingTree: false });
      const renamed = files.find((file) => file.path === 'b.txt');
      assert.equal(renamed?.status, 'renamed');
      assert.equal(renamed?.previousPath, 'a.txt');
    } finally {
      removeDir(dir);
    }
  });

  it('scopes diff output to the requested paths', () => {
    const revision = { spec: 'main...HEAD', description: '', includesWorkingTree: false };
    const diff = git.diff(revision, ['types/message.ts'], 0);
    assert.match(diff, /types\/message\.ts/);
    assert.ok(!diff.includes('migrations/'));
  });

  it('returns an empty diff for an empty path list rather than diffing everything', () => {
    const revision = { spec: 'main...HEAD', description: '', includesWorkingTree: false };
    assert.equal(git.diff(revision, []), '');
  });

  it('lists untracked files, which no diff can represent', () => {
    const dir = tempDir();
    try {
      initRepo(dir);
      writeFiles(dir, { 'a.txt': 'one\n', '.gitignore': 'ignored/\n' });
      commitAll(dir, 'first');
      writeFiles(dir, {
        'a.txt': 'two\n',
        'migrations/003_plan.sql': 'ALTER TABLE users ADD COLUMN plan TEXT;\n',
        'ignored/build.js': 'nope\n',
      });
      const local = new Git(dir);
      const files = local.changedFiles({ spec: 'HEAD', description: '', includesWorkingTree: true });
      const byPath = new Map(files.map((file) => [file.path, file]));

      assert.deepEqual([...byPath.keys()].sort(), ['a.txt', 'migrations/003_plan.sql']);
      assert.equal(byPath.get('migrations/003_plan.sql')?.status, 'added');
      assert.equal(byPath.get('migrations/003_plan.sql')?.additions, 1);
      assert.equal(byPath.get('migrations/003_plan.sql')?.deletions, 0);
      assert.equal(local.failures.length, 0);
    } finally {
      removeDir(dir);
    }
  });

  it('keeps untracked files out of a staged revision, where they do not belong', () => {
    const dir = tempDir();
    try {
      initRepo(dir);
      writeFiles(dir, { 'a.txt': 'one\n' });
      commitAll(dir, 'first');
      writeFiles(dir, { 'a.txt': 'two\n', 'new.txt': 'fresh\n' });
      runGit(dir, ['add', 'a.txt']);
      const local = new Git(dir);
      const files = local.changedFiles({ spec: '--cached', description: '', includesWorkingTree: true });
      assert.deepEqual(files.map((file) => file.path), ['a.txt']);
    } finally {
      removeDir(dir);
    }
  });

  it('shows the contents of an untracked file in the diff the collectors read', () => {
    const dir = tempDir();
    try {
      initRepo(dir);
      writeFiles(dir, { 'a.txt': 'one\n' });
      commitAll(dir, 'first');
      writeFiles(dir, { '.env.example': 'STRIPE_WEBHOOK_SECRET=\n' });
      const local = new Git(dir);
      const diff = local.diff(
        { spec: 'HEAD', description: '', includesWorkingTree: true },
        ['.env.example'],
      );
      assert.match(diff, /^diff --git a\/\.env\.example b\/\.env\.example$/m);
      assert.match(diff, /^\+STRIPE_WEBHOOK_SECRET=$/m);
    } finally {
      removeDir(dir);
    }
  });
});

describe('parseNumstatPath', () => {
  it('unwinds the braced rename form', () => {
    assert.deepEqual(parseNumstatPath('src/{old => new}/file.ts'), {
      path: 'src/new/file.ts',
      previousPath: 'src/old/file.ts',
    });
  });

  it('unwinds the plain arrow form', () => {
    assert.deepEqual(parseNumstatPath('a.txt => b.txt'), { path: 'b.txt', previousPath: 'a.txt' });
  });

  it('collapses the doubled separator when a path segment is emptied', () => {
    assert.equal(parseNumstatPath('src/{lib => }/file.ts').path, 'src/file.ts');
  });

  it('leaves an ordinary path alone', () => {
    assert.deepEqual(parseNumstatPath('src/index.ts'), { path: 'src/index.ts' });
  });
});

describe('repoSlug', () => {
  it('handles SSH, HTTPS and .git suffixes', () => {
    assert.equal(repoSlug('git@github.com:acme/backend.git'), 'acme/backend');
    assert.equal(repoSlug('https://github.com/acme/backend.git'), 'acme/backend');
    assert.equal(repoSlug('https://gitlab.com/group/sub/project'), 'group/sub/project');
  });

  it('returns null for something that is not a URL', () => {
    assert.equal(repoSlug('not a url'), null);
  });
});

describe('parseUnifiedDiff', () => {
  const sample = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1,2 @@',
    '-const a = 1;',
    '+const a = 2;',
    '+const b = 3;',
    'diff --git a/src/b.ts b/src/b.ts',
    '@@ -0,0 +1 @@',
    '+export {};',
  ].join('\n');

  it('splits per file and keeps only added and removed lines', () => {
    const files = parseUnifiedDiff(sample);
    assert.deepEqual(files.map((file) => file.path), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(files[0]?.added, ['const a = 2;', 'const b = 3;']);
    assert.deepEqual(files[0]?.removed, ['const a = 1;']);
  });

  it('does not mistake the +++ and --- headers for content', () => {
    const files = parseUnifiedDiff(sample);
    assert.ok(!files[0]?.added.some((line) => line.startsWith('+ b/')));
  });

  it('records a rename header', () => {
    const files = parseUnifiedDiff('diff --git a/x.ts b/y.ts\nrename from x.ts\n+a\n');
    assert.equal(files[0]?.previousPath, 'x.ts');
  });

  it('returns nothing for empty input', () => {
    assert.deepEqual(parseUnifiedDiff(''), []);
  });
});

describe('trulyAdded / trulyRemoved', () => {
  it('ignores lines that only moved or were reindented', () => {
    const file = {
      path: 'x.ts',
      added: ['  const a = 1;', 'const brand = new();'],
      removed: ['const a = 1;', 'const old = 1;'],
    };
    assert.deepEqual(trulyAdded(file), ['const brand = new();']);
    assert.deepEqual(trulyRemoved(file), ['const old = 1;']);
  });

  it('drops blank lines', () => {
    assert.deepEqual(trulyAdded({ path: 'x', added: ['', '   '], removed: [] }), []);
  });
});

/** A date git will accept that no commit in a test repository can possibly be after. */
function futureDate(): string {
  return `${new Date().getUTCFullYear() + 2}-01-01`;
}

describe('resolveRevision', () => {
  const git = new Git(repo);

  it('defaults to the branch since it forked from trunk', () => {
    const revision = resolveRevision(git, {});
    assert.equal(revision.spec, 'main...HEAD');
    assert.match(revision.description, /since main/);
  });

  it('honours an explicit base', () => {
    assert.equal(resolveRevision(git, { base: 'main' }).spec, 'main...HEAD');
  });

  it('falls back to the most recent commit when the base does not exist', () => {
    const revision = resolveRevision(git, { base: 'no-such-branch' });
    assert.equal(revision.spec, 'HEAD~1..HEAD');
    assert.match(revision.description, /not found/);
  });

  it('honours a commit count', () => {
    assert.equal(resolveRevision(git, { commits: 1 }).spec, 'HEAD~1..HEAD');
  });

  it('takes the whole history when it is shorter than the count', () => {
    // `HEAD~99` does not exist here, and a range git cannot resolve fails the whole diff.
    const revision = resolveRevision(git, { commits: 99 });
    assert.match(revision.spec, /^[0-9a-f]{40,64}\.\.HEAD$/);
    assert.equal(revision.logSpec, 'HEAD');
    assert.match(revision.description, /whole history/);
  });

  it('selects the working tree when asked', () => {
    const revision = resolveRevision(git, { working: true });
    assert.equal(revision.includesWorkingTree, true);
    assert.equal(revision.spec, 'HEAD');
  });

  it('selects the index when asked for staged changes', () => {
    assert.equal(resolveRevision(git, { staged: true }).spec, '--cached');
  });

  it('diffs against the merge base but logs only this side of it', () => {
    // `git log A...B` is the symmetric difference: it would attribute trunk commits made
    // by other people to this handoff.
    const revision = resolveRevision(git, { base: 'main' });
    assert.equal(revision.spec, 'main...HEAD');
    assert.equal(commitRange(revision), 'main..HEAD');
  });

  it('selects nothing, not the working tree, when --since matches no commits', () => {
    const dir = tempDir();
    try {
      initRepo(dir);
      writeFiles(dir, { 'a.txt': 'one' });
      commitAll(dir, 'first');
      writeFiles(dir, { 'a.txt': 'uncommitted' });
      const local = new Git(dir);
      const revision = resolveRevision(local, { since: futureDate() });

      assert.deepEqual(local.changedFiles(revision), []);
      assert.deepEqual(local.commits(commitRange(revision), 20), []);
    } finally {
      removeDir(dir);
    }
  });

  it('handles a --since window that reaches the root commit', () => {
    const dir = tempDir();
    try {
      initRepo(dir);
      writeFiles(dir, { 'a.txt': 'one' });
      commitAll(dir, 'first');
      writeFiles(dir, { 'b.txt': 'two' });
      commitAll(dir, 'second');
      const local = new Git(dir);
      const revision = resolveRevision(local, { since: '10 years ago' });

      const paths = local.changedFiles(revision).map((file) => file.path).sort();
      assert.deepEqual(paths, ['a.txt', 'b.txt'], 'the root commit is part of the window');
      assert.equal(local.commits(commitRange(revision), 20).length, 2);
      assert.deepEqual(local.failures, []);
    } finally {
      removeDir(dir);
    }
  });

  it('falls back to the last commit on a clean trunk with no fork point', () => {
    const dir = tempDir();
    try {
      initRepo(dir);
      writeFiles(dir, { 'a.txt': 'one' });
      commitAll(dir, 'first');
      writeFiles(dir, { 'a.txt': 'two' });
      commitAll(dir, 'second');
      assert.equal(resolveRevision(new Git(dir), {}).spec, 'HEAD~1..HEAD');
    } finally {
      removeDir(dir);
    }
  });
});
