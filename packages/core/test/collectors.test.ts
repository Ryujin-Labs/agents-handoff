import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { classifyPath, isNoise } from '../src/collectors/classify.ts';
import { memberNames } from '../src/collectors/contracts.ts';
import { detectTestCommand } from '../src/collectors/tests.ts';
import { loadConfig } from '../src/config/index.ts';
import {
  allSignals,
  breakingCandidates,
  collectChangeContext,
  inferChangeTypes,
} from '../src/context/collect.ts';
import { briefToJson, renderBrief } from '../src/context/brief.ts';
import type { Signal } from '../src/collectors/types.ts';
import { Git } from '../src/git/index.ts';
import { commitAll, git as runGit, initRepo, removeDir, scenarioRepo, tempDir, writeFiles } from './helpers.ts';

const repo = scenarioRepo();
after(() => removeDir(repo));

function contextFor(dir: string, targets: string[] = ['mobile']) {
  return collectChangeContext({ cwd: dir, loaded: loadConfig(dir), targets });
}

function messages(signals: Signal[]): string[] {
  return signals.map((signal) => signal.message);
}

describe('classifyPath', () => {
  it('recognizes API surfaces across framework layouts', () => {
    assert.ok(classifyPath('src/routes/messages.ts').includes('api'));
    assert.ok(classifyPath('src/users.controller.ts').includes('api'));
    assert.ok(classifyPath('app/api/messages/route.ts').includes('api'));
    assert.ok(classifyPath('openapi.yaml').includes('api'));
    assert.ok(classifyPath('proto/service.proto').includes('api'));
  });

  it('recognizes auth, database, environment and dependency files', () => {
    assert.ok(classifyPath('src/auth/guards/jwt.guard.ts').includes('auth'));
    assert.ok(classifyPath('migrations/001_init.sql').includes('database'));
    assert.ok(classifyPath('.env.example').includes('environment'));
    assert.ok(classifyPath('package.json').includes('dependency'));
    assert.ok(classifyPath('Dockerfile').includes('infrastructure'));
    assert.ok(classifyPath('src/user.test.ts').includes('test'));
  });

  it('marks build output as generated and nothing else', () => {
    assert.deepEqual(classifyPath('dist/bundle.js'), ['generated']);
    assert.deepEqual(classifyPath('node_modules/x/index.js'), ['generated']);
    assert.equal(isNoise('coverage/lcov.info'), true);
    assert.equal(isNoise('src/index.ts'), false);
  });

  it('falls back to `source` for an unremarkable file', () => {
    assert.deepEqual(classifyPath('src/lib/helpers.ts'), ['source']);
  });
});

describe('memberNames', () => {
  it('finds fields declared on one line', () => {
    assert.deepEqual(
      memberNames('export interface Message { messageId: string; retentionDays: number }'),
      ['messageId', 'retentionDays'],
    );
  });

  it('finds a field on its own line', () => {
    assert.deepEqual(memberNames('  retentionDays: number;'), ['retentionDays']);
  });

  it('ignores control flow that superficially looks like a declaration', () => {
    assert.deepEqual(memberNames('  if (x) return { a: 1 };'), ['a']);
    assert.deepEqual(memberNames('  return foo;'), []);
    assert.deepEqual(memberNames('  for (const x of y) {'), []);
  });
});

describe('collectChangeContext', () => {
  const context = contextFor(repo);

  it('excludes build output from the analyzed set', () => {
    assert.ok(!context.changedFiles.some((file) => file.path.startsWith('dist/')));
    assert.deepEqual(context.ignoredFiles, ['dist/bundle.js']);
  });

  it('reports the repository and revision', () => {
    assert.equal(context.repo?.branch, 'feature/message-auth');
    assert.equal(context.revision.spec, 'main...HEAD');
    assert.deepEqual(context.targets, ['mobile']);
  });

  it('degrades gracefully outside a git repository', () => {
    const dir = tempDir();
    try {
      const outside = contextFor(dir);
      assert.equal(outside.repo, null);
      assert.deepEqual(outside.changedFiles, []);
      assert.match(outside.warnings.join(' '), /Not a git repository/);
    } finally {
      removeDir(dir);
    }
  });

  it('warns when the revision contains no changes', () => {
    const dir = tempDir();
    try {
      initRepo(dir);
      writeFiles(dir, { 'a.txt': 'one' });
      commitAll(dir, 'first');
      writeFiles(dir, { 'a.txt': 'two' });
      commitAll(dir, 'second');
      const empty = collectChangeContext({
        cwd: dir,
        loaded: loadConfig(dir),
        base: 'HEAD',
      });
      assert.match(empty.warnings.join(' '), /No changes found/);
    } finally {
      removeDir(dir);
    }
  });
});

describe('untracked files', () => {
  it('are part of the change even though no diff can show them', () => {
    const dir = tempDir();
    try {
      initRepo(dir);
      writeFiles(dir, { 'package.json': '{"name":"fixture"}\n' });
      commitAll(dir, 'initial');
      // A new migration and a new .env.example: the exact shape of change that lives
      // entirely in files git has never seen.
      writeFiles(dir, {
        '.env.example': 'STRIPE_WEBHOOK_SECRET=\n',
        'migrations/004_plan.sql': 'ALTER TABLE users ADD COLUMN plan TEXT;\n',
      });

      const context = contextFor(dir);
      assert.deepEqual(
        context.changedFiles.map((file) => file.path).sort(),
        ['.env.example', 'migrations/004_plan.sql'],
      );
      assert.ok(!context.warnings.join(' ').includes('No changes found'), context.warnings.join(' '));
      assert.ok(
        messages(allSignals(context)).includes('new environment variable: STRIPE_WEBHOOK_SECRET'),
        'collectors must see the contents of an untracked file',
      );
    } finally {
      removeDir(dir);
    }
  });
});

describe('commit attribution', () => {
  it('leaves out trunk commits made after this branch forked', () => {
    const dir = tempDir();
    try {
      initRepo(dir);
      writeFiles(dir, { 'a.txt': 'one' });
      commitAll(dir, 'initial');
      runGit(dir, ['checkout', '-q', '-b', 'feature']);
      writeFiles(dir, { 'src/feature.ts': 'export const feature = 1;\n' });
      commitAll(dir, 'add the feature');
      // Trunk moves on, as it does after any fetch.
      runGit(dir, ['checkout', '-q', 'main']);
      writeFiles(dir, { 'src/unrelated.ts': 'export const unrelated = 1;\n' });
      commitAll(dir, 'unrelated trunk work');
      runGit(dir, ['checkout', '-q', 'feature']);

      const context = contextFor(dir);
      const commits =
        context.results
          .find((result) => result.name === 'git')
          ?.facts.find((fact) => fact.label === 'commits')?.value ?? '';

      assert.match(commits, /add the feature/);
      assert.ok(!commits.includes('unrelated trunk work'), commits);
      assert.deepEqual(context.changedFiles.map((file) => file.path), ['src/feature.ts']);
    } finally {
      removeDir(dir);
    }
  });

  it('describes no commits at all when --since matches an empty window', () => {
    const dir = tempDir();
    try {
      initRepo(dir);
      writeFiles(dir, { 'a.txt': 'one' });
      commitAll(dir, 'first');
      writeFiles(dir, { 'a.txt': 'two' });
      commitAll(dir, 'second');
      writeFiles(dir, { 'a.txt': 'uncommitted' });

      // A date in the future, so no commit can fall inside the window.
      const since = `${new Date().getUTCFullYear() + 2}-01-01`;
      const context = collectChangeContext({ cwd: dir, loaded: loadConfig(dir), since });
      const gitResult = context.results.find((result) => result.name === 'git');

      assert.deepEqual(context.changedFiles, [], 'the working tree is not committed history');
      assert.equal(gitResult?.facts.find((fact) => fact.label === 'commits'), undefined);
      assert.match(context.warnings.join(' '), /No changes found/);
    } finally {
      removeDir(dir);
    }
  });
});

describe('api collector', () => {
  const signals = messages(allSignals(contextFor(repo)));

  it('reports an edited handler as changed, not removed', () => {
    assert.ok(signals.includes('handler changed: POST /messages'));
    assert.ok(!signals.some((message) => message.startsWith('removed: POST /messages')));
  });

  it('does not raise a breaking candidate for a route that still exists', () => {
    const candidates = messages(breakingCandidates(contextFor(repo)));
    assert.ok(!candidates.some((message) => message.includes('POST /messages')));
  });
});

describe('auth collector', () => {
  it('finds a permission check in a route file, not only in auth-named files', () => {
    const signals = allSignals(contextFor(repo)).filter((signal) => signal.kind === 'auth');
    assert.ok(signals.some((signal) => signal.file === 'src/routes/messages.ts'));
    assert.ok(messages(signals).some((message) => message.includes('permission check')));
  });
});

describe('contract collector', () => {
  const signals = allSignals(contextFor(repo));

  it('detects an added field', () => {
    assert.ok(messages(signals).includes('field added: retentionDays'));
  });

  it('raises a removed field as a breaking candidate', () => {
    assert.ok(messages(breakingCandidates(contextFor(repo))).includes('field removed: id'));
  });

  it('does not report a field that was only retyped', () => {
    assert.ok(!messages(breakingCandidates(contextFor(repo))).includes('field removed: body'));
  });
});

describe('database collector', () => {
  const candidates = messages(breakingCandidates(contextFor(repo)));

  it('flags a dropped column as destructive', () => {
    assert.ok(candidates.some((message) => message.includes('column dropped: legacy_id')));
  });

  it('does not flag an added column', () => {
    assert.ok(!candidates.some((message) => message.includes('retention_days')));
  });
});

describe('environment collector', () => {
  it('finds a newly read environment variable', () => {
    const signals = allSignals(contextFor(repo)).filter((signal) => signal.kind === 'environment');
    assert.ok(messages(signals).includes('new environment variable: MESSAGE_RETENTION_DAYS'));
  });
});

describe('detectTestCommand', () => {
  it('prefers an npm test script', () => {
    assert.equal(detectTestCommand(repo), 'npm run test');
  });

  it('recognizes other ecosystems by their manifest', () => {
    const dir = tempDir();
    try {
      writeFiles(dir, { 'go.mod': 'module x\n' });
      assert.equal(detectTestCommand(dir), 'go test ./...');
    } finally {
      removeDir(dir);
    }
  });

  it('returns null when it cannot tell', () => {
    const dir = tempDir();
    try {
      assert.equal(detectTestCommand(dir), null);
    } finally {
      removeDir(dir);
    }
  });
});

describe('inferChangeTypes', () => {
  it('maps signals onto vocabulary terms', () => {
    const types = inferChangeTypes(contextFor(repo));
    for (const expected of ['api', 'authentication', 'contract', 'database', 'environment']) {
      assert.ok(types.includes(expected), `missing ${expected} in ${types.join(', ')}`);
    }
  });

  it('falls back to `behavior` when nothing was detected', () => {
    const dir = tempDir();
    try {
      assert.deepEqual(inferChangeTypes(contextFor(dir)), ['behavior']);
    } finally {
      removeDir(dir);
    }
  });
});

describe('renderBrief', () => {
  const brief = renderBrief(contextFor(repo));

  it('includes the repository, files and signals', () => {
    assert.match(brief, /# Handoff Context Brief/);
    assert.match(brief, /branch: feature\/message-auth/);
    assert.match(brief, /src\/routes\/messages\.ts/);
    assert.match(brief, /## Possible breaking changes/);
  });

  it('states plainly that breaking candidates are matches rather than findings', () => {
    assert.match(brief, /Pattern matches only/);
  });

  it('names what it is missing rather than implying completeness', () => {
    assert.match(brief, /## What this brief does not contain/);
    assert.match(brief, /agent conversation/i);
  });

  it('never contains raw diff hunks', () => {
    assert.ok(!/^@@ -/m.test(brief));
    assert.ok(!/^diff --git /m.test(brief));
  });
});

describe('briefToJson', () => {
  it('exposes the same information in structured form', () => {
    const json = briefToJson(contextFor(repo)) as Record<string, unknown>;
    assert.equal(typeof json['generated_at'], 'string');
    assert.ok(Array.isArray(json['changed_files']));
    assert.ok(Array.isArray(json['breaking_candidates']));
    assert.ok(Array.isArray(json['inferred_change_type']));
  });
});

describe('git failures are reported, not swallowed', () => {
  it('warns that git did not answer rather than claiming a clean tree', () => {
    const dir = tempDir();
    try {
      initRepo(dir);
      writeFiles(dir, { 'a.txt': 'one' });
      commitAll(dir, 'first');
      writeFiles(dir, { 'a.txt': 'two' });
      commitAll(dir, 'second');
      // A repository missing an object: the range resolves, and `git diff` then fails.
      const blob = runGit(dir, ['rev-parse', 'HEAD:a.txt']).trim();
      rmSync(join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true });
      const context = collectChangeContext({ cwd: dir, loaded: loadConfig(dir), commits: 1 });
      const joined = context.warnings.join(' ');
      assert.match(joined, /git did not answer/);
      assert.ok(!/No changes found/.test(joined), 'must not also claim the tree is clean');
    } finally {
      removeDir(dir);
    }
  });

  it('reports a diff that fails inside a collector, not only one that fails before them', () => {
    const original = Git.prototype.diff;
    // Collectors run after the file list is built and make their own git calls, so the
    // failure they hit (maxBuffer on a huge change, a real timeout) is recorded late.
    Git.prototype.diff = function stubbed(this: Git): string {
      this.failures.push('git diff: timed out after 45000ms (raise HANDOFF_GIT_TIMEOUT_MS)');
      return '';
    };
    try {
      const context = contextFor(repo);
      assert.match(context.warnings.join(' '), /git did not answer/);
      assert.match(context.warnings.join(' '), /timed out/);
    } finally {
      Git.prototype.diff = original;
    }
  });

  it('says nothing when git answers normally', () => {
    const context = contextFor(repo);
    assert.ok(!context.warnings.join(' ').includes('git did not answer'));
  });
});
