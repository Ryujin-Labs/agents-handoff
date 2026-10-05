import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(here, '..', 'src', 'bin.js');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the real binary. These tests are slower than calling `main()` directly, and that is
 * the point: they are the only thing that proves the built package actually runs, that the
 * bin path in package.json is right, and that exit codes reach the shell.
 */
function handoff(cwd: string, args: string[], input?: string): Run {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    input: input ?? '',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-cli-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'package.json'), '{"name":"svc","scripts":{"test":"vitest"}}\n');
  writeFileSync(join(dir, 'app.js'), "const a = require('express')();\n");
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);

  git(dir, ['checkout', '-q', '-b', 'feature/scopes']);
  writeFileSync(
    join(dir, 'routes.js'),
    "const r = require('express').Router();\nr.post('/messages', guard('write'), (q, s) => s.status(201).json({}));\nmodule.exports = r;\n",
  );
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'add scope guard']);
  return dir;
}

const repo = makeRepo();
const dirs: string[] = [repo];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const FINISHED_HANDOFF = `---
handoff_version: 1
id: 2026-08-28-scopes
title: Messages need the write scope
created_at: 2026-08-28T10:00:00Z
status: ready
breaking: true
source:
  project: svc
targets:
  - mobile
change_type:
  - api
---

# Messages need the write scope

## Summary

\`POST /messages\` now requires the \`write\` scope and returns 201.

## Why This Matters

Existing tokens lack the scope, so sends will fail with 403.

## Changes

Previous: any valid token, 200. New: \`write\` scope required, 201.

## Required Actions

1. Request the \`write\` scope at login.
2. Treat 403 differently from 401.
3. Accept 201 as success.

## Breaking Changes

Every existing build loses the ability to send messages.

## Verification

Send with a scoped token and with an unscoped one.

## Instructions for Receiving Agent

Change the existing auth request. Do not add a second token store.
`;

/** The same document, split by target, for the narrowing tests. */
const SPLIT_HANDOFF = FINISHED_HANDOFF.replace('targets:\n  - mobile', 'targets:\n  - mobile\n  - web').replace(
  /## Required Actions\n[\s\S]*?(?=## Breaking)/,
  ['## Required Actions', '', '### mobile', '', '1. Store the token in the keychain.', '', '### web', '', '1. Route the service worker through one refresh call.', '', ''].join('\n'),
);

describe('handoff --version and help', () => {
  it('prints a version', () => {
    const result = handoff(repo, ['--version']);
    assert.equal(result.code, 0);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it('lists every command in the help output', () => {
    const result = handoff(repo, ['help']);
    assert.equal(result.code, 0);
    for (const command of ['init', 'context', 'create', 'list', 'show', 'validate', 'receive', 'send', 'config', 'install']) {
      assert.match(result.stdout, new RegExp(`\\b${command}\\b`), `help is missing ${command}`);
    }
  });

  it('shows per-command help with its options', () => {
    const result = handoff(repo, ['create', '--help']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /--target/);
  });

  it('fails on an unknown command', () => {
    const result = handoff(repo, ['nonsense']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown command/);
  });

  it('fails on an unknown flag rather than ignoring it', () => {
    const result = handoff(repo, ['create', '--not-a-flag']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /error/);
  });
});

describe('handoff init', () => {
  it('writes a config and creates the storage directory', () => {
    const result = handoff(repo, ['init', '--project', 'svc', '--targets', 'mobile,web', '--gitignore']);
    assert.equal(result.code, 0);
    assert.ok(existsSync(join(repo, 'handoff.config.json')));
    assert.ok(existsSync(join(repo, '.handoff')));

    const config = JSON.parse(readFileSync(join(repo, 'handoff.config.json'), 'utf8'));
    assert.equal(config.project, 'svc');
    assert.deepEqual(config.targets, ['mobile', 'web']);
    assert.equal(config.gitignore, true);
    assert.match(readFileSync(join(repo, '.gitignore'), 'utf8'), /\.handoff\//);
  });

  it('is safe to re-run and does not clobber without --force', () => {
    const result = handoff(repo, ['init']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Already initialized/);
    assert.equal(JSON.parse(readFileSync(join(repo, 'handoff.config.json'), 'utf8')).project, 'svc');
  });
});

describe('handoff context', () => {
  it('emits a Markdown brief with the collected signals', () => {
    const result = handoff(repo, ['context', '--target', 'mobile']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /# Handoff Context Brief/);
    assert.match(result.stdout, /routes\.js/);
    assert.match(result.stdout, /targets: mobile/);
  });

  it('emits parseable JSON with --json', () => {
    const result = handoff(repo, ['context', '--json']);
    const json = JSON.parse(result.stdout);
    assert.ok(Array.isArray(json.changed_files));
    assert.equal(typeof json.revision.spec, 'string');
  });

  it('exits 2 when the revision contains no changes', () => {
    const result = handoff(repo, ['context', '--base', 'HEAD']);
    assert.equal(result.code, 2);
  });

  it('rejects a non-numeric --commits', () => {
    const result = handoff(repo, ['context', '--commits', 'lots']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /positive integer/);
  });
});

describe('handoff create', () => {
  it('scaffolds a draft with real git facts', () => {
    const result = handoff(repo, ['create', '--target', 'mobile', '--title', 'Scope required', '--json']);
    assert.equal(result.code, 0);

    const json = JSON.parse(result.stdout);
    assert.match(json.id, /^\d{4}-\d{2}-\d{2}-scope-required$/);
    assert.deepEqual(json.targets, ['mobile']);

    const document = readFileSync(json.path, 'utf8');
    assert.match(document, /branch: feature\/scopes/);
    assert.match(document, /# Scope required/);
    assert.match(document, /TODO/);
  });

  it('refuses to overwrite an existing id without --force', () => {
    const first = JSON.parse(handoff(repo, ['create', '--title', 'Dup test', '--id', 'dup-test', '--json']).stdout);
    assert.ok(existsSync(first.path));
    const second = handoff(repo, ['create', '--title', 'Dup test', '--id', 'dup-test']);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /already exists/);
    assert.equal(handoff(repo, ['create', '--title', 'Dup test', '--id', 'dup-test', '--force']).code, 0);
  });

  it('prints without writing when given --print', () => {
    const before = handoff(repo, ['list', '--json']).stdout;
    const result = handoff(repo, ['create', '--title', 'Not saved', '--print']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^---/);
    assert.equal(handoff(repo, ['list', '--json']).stdout, before);
  });

  it('stores a finished document piped in on stdin', () => {
    const result = handoff(repo, ['create', '--stdin', '--json'], FINISHED_HANDOFF);
    assert.equal(result.code, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.id, '2026-08-28-scopes');
    assert.ok(existsSync(json.path));
  });

  it('rejects an invalid document on stdin', () => {
    const broken = FINISHED_HANDOFF.replace(/## Required Actions[\s\S]*?(?=## Breaking)/, '');
    const result = handoff(repo, ['create', '--stdin'], broken);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Required Actions/);
  });

  it('refuses a document containing a credential', () => {
    const leaky = FINISHED_HANDOFF.replace(
      '## Verification',
      '## Notes\n\nUse token ghp_abcdefghijklmnopqrstuvwxyz0123456789 to test.\n\n## Verification',
    ).replace('id: 2026-08-28-scopes', 'id: 2026-08-28-leaky');
    const result = handoff(repo, ['create', '--stdin'], leaky);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /secret/);
  });
});

describe('handoff list / show / validate', () => {
  it('lists what was created', () => {
    const json = JSON.parse(handoff(repo, ['list', '--json']).stdout);
    assert.ok(json.handoffs.some((entry: { id: string }) => entry.id === '2026-08-28-scopes'));
  });

  it('shows one handoff and resolves a partial id', () => {
    const result = handoff(repo, ['show', 'scopes']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Messages need the write scope/);
    assert.match(result.stdout, /breaking\s+yes/);
  });

  it('prints a single section on request', () => {
    const result = handoff(repo, ['show', '2026-08-28-scopes', '--section', 'Required Actions']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Request the `write` scope/);
    assert.ok(!result.stdout.includes('## Summary'));
  });

  it('fails on a reference that matches nothing', () => {
    assert.equal(handoff(repo, ['show', 'no-such-handoff']).code, 1);
  });

  it('validates a good document and rejects a bad one', () => {
    assert.equal(handoff(repo, ['validate', '2026-08-28-scopes', '--strict']).code, 0);

    const badPath = join(repo, 'bad.md');
    writeFileSync(badPath, '---\nhandoff_version: 9\n---\n\n# Nope\n');
    const result = handoff(repo, ['validate', 'bad.md']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /handoff_version 9 is not supported/);

    // Human output stays prose; machine-readable codes live in --json.
    const json = JSON.parse(handoff(repo, ['validate', 'bad.md', '--json']).stdout);
    assert.equal(json.ok, false);
    assert.ok(json.errors.some((issue: { code: string }) => issue.code === 'unsupported-version'));
  });

  it('fails --strict on a scaffold that still has TODOs', () => {
    const created = JSON.parse(handoff(repo, ['create', '--title', 'Strict check', '--json']).stdout);
    assert.equal(handoff(repo, ['validate', created.path]).code, 0);
    const strict = handoff(repo, ['validate', created.path, '--strict']);
    assert.equal(strict.code, 1);
    assert.match(strict.stderr, /TODO/);
  });
});

describe('handoff receive', () => {
  it('reads a handoff into a different repository and narrows it to the target', () => {
    const consumer = mkdtempSync(join(tmpdir(), 'handoff-consumer-'));
    dirs.push(consumer);
    git(consumer, ['init', '-q', '-b', 'main']);
    git(consumer, ['config', 'user.email', 'm@example.com']);
    git(consumer, ['config', 'user.name', 'M']);
    writeFileSync(join(consumer, 'package.json'), '{"name":"app"}\n');
    git(consumer, ['add', '-A']);
    git(consumer, ['commit', '-q', '-m', 'init']);

    const file = join(consumer, 'incoming.md');
    writeFileSync(file, FINISHED_HANDOFF);

    const result = handoff(consumer, ['receive', 'incoming.md', '--as', 'mobile']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /# Incoming handoff/);
    assert.ok(result.stdout.indexOf('## Required Actions') < result.stdout.indexOf('## Summary'));
    assert.match(result.stdout, /This is a breaking change/);
    assert.ok(existsSync(join(consumer, '.handoff', 'inbox', '2026-08-28-scopes', 'HANDOFF.md')));

    const listed = JSON.parse(handoff(consumer, ['list', '--inbox', '--json']).stdout);
    assert.equal(listed.handoffs.length, 1);
  });

  it('reports that it does not apply to an unlisted target', () => {
    const consumer = mkdtempSync(join(tmpdir(), 'handoff-devops-'));
    dirs.push(consumer);
    writeFileSync(join(consumer, 'incoming.md'), FINISHED_HANDOFF);
    const result = handoff(consumer, ['receive', 'incoming.md', '--as', 'devops', '--no-store']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /does not include "devops"/);
    assert.ok(!existsSync(join(consumer, '.handoff')));
  });

  it('does not use the send-side defaultTarget as this repository\'s identity', () => {
    // `defaultTarget: mobile` on a backend means "we usually hand off to mobile". Read as an
    // identity it made the backend implement the mobile block of someone else's handoff.
    const consumer = mkdtempSync(join(tmpdir(), 'handoff-identity-'));
    dirs.push(consumer);
    writeFileSync(
      join(consumer, 'handoff.config.json'),
      `${JSON.stringify({ version: 1, project: 'backend', targets: ['mobile', 'web'], defaultTarget: 'mobile' }, null, 2)}\n`,
    );
    writeFileSync(join(consumer, 'incoming.md'), SPLIT_HANDOFF);

    const result = handoff(consumer, ['receive', 'incoming.md', '--no-store']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Pass --as <target> to narrow it/);
    assert.match(result.stdout, /keychain/);
    assert.match(result.stdout, /service worker/);
  });

  it('narrows to the identity config key when the repository declares one', () => {
    const consumer = mkdtempSync(join(tmpdir(), 'handoff-identity-set-'));
    dirs.push(consumer);
    writeFileSync(
      join(consumer, 'handoff.config.json'),
      `${JSON.stringify({ version: 1, project: 'webapp', defaultTarget: 'mobile', identity: 'web' }, null, 2)}\n`,
    );
    writeFileSync(join(consumer, 'incoming.md'), SPLIT_HANDOFF);

    const result = handoff(consumer, ['receive', 'incoming.md', '--no-store']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /includes "web"/);
    assert.match(result.stdout, /service worker/);
    assert.ok(!result.stdout.includes('keychain'));
  });

  it('fails clearly on a file that is not a handoff', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-bad-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'notes.md'), '# Just some notes\n');
    const result = handoff(dir, ['receive', 'notes.md']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not a v1 handoff/);
  });

  it('fails on a path that does not exist', () => {
    assert.equal(handoff(repo, ['receive', 'missing.md']).code, 1);
  });
});

describe('handoff send', () => {
  it('writes a copy to a chosen path', () => {
    const target = join(repo, 'outbox', 'scopes.md');
    const result = handoff(repo, ['send', '2026-08-28-scopes', '--channel', 'file', '--to', target]);
    assert.equal(result.code, 0);
    assert.match(readFileSync(target, 'utf8'), /Messages need the write scope/);
  });

  it('prints to stdout when asked', () => {
    const result = handoff(repo, ['send', '2026-08-28-scopes', '--channel', 'stdout']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^---\nhandoff_version: 1/);
  });

  it('rejects an unknown channel', () => {
    const result = handoff(repo, ['send', '2026-08-28-scopes', '--channel', 'carrier-pigeon']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown channel/);
  });
});

describe('handoff config', () => {
  it('prints the resolved configuration as JSON', () => {
    const json = JSON.parse(handoff(repo, ['config', '--json']).stdout);
    assert.equal(json.project, 'svc');
    assert.equal(json._exists, true);
  });

  it('lists collectors and channels', () => {
    assert.match(handoff(repo, ['config', '--collectors']).stdout, /agent-context/);
    assert.match(handoff(repo, ['config', '--channels']).stdout, /clipboard/);
  });

  it('updates a setting and reads it back', () => {
    assert.equal(handoff(repo, ['config', '--set-default-target', 'mobile']).code, 0);
    assert.equal(JSON.parse(handoff(repo, ['config', '--json']).stdout).defaultTarget, 'mobile');
  });

  it('works with no config file at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-noconfig-'));
    dirs.push(dir);
    const result = handoff(dir, ['config']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /defaults; no config file found/);
  });
});

describe('handoff install claude-code', () => {
  it('writes both skills into .claude/skills', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-install-'));
    dirs.push(dir);
    const result = handoff(dir, ['install', 'claude-code']);
    assert.equal(result.code, 0);

    for (const skill of ['handoff', 'handoff-receive']) {
      const path = join(dir, '.claude', 'skills', skill, 'SKILL.md');
      assert.ok(existsSync(path), `${skill} was not installed`);
      const contents = readFileSync(path, 'utf8');
      assert.match(contents, /^---\n/);
      assert.match(contents, new RegExp(`name: "${skill}"`));
    }
  });

  it('does not overwrite a modified skill without --force', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-install2-'));
    dirs.push(dir);
    handoff(dir, ['install', 'claude-code']);
    const path = join(dir, '.claude', 'skills', 'handoff', 'SKILL.md');
    writeFileSync(path, '---\nname: handoff\n---\n\nlocally edited\n');

    assert.match(handoff(dir, ['install', 'claude-code']).stdout, /skipped/);
    assert.match(readFileSync(path, 'utf8'), /locally edited/);

    handoff(dir, ['install', 'claude-code', '--force']);
    assert.ok(!readFileSync(path, 'utf8').includes('locally edited'));
  });

  it('rejects an unknown integration', () => {
    const result = handoff(repo, ['install', 'emacs']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown integration/);
  });
});

describe('the full loop', () => {
  it('goes from a change to a receiving agent brief', () => {
    // 1. A backend developer inspects the change.
    const context = handoff(repo, ['context', '--target', 'mobile']);
    assert.equal(context.code, 0);

    // 2. Their agent writes the finished handoff through the same storage path.
    const created = JSON.parse(
      handoff(repo, ['create', '--stdin', '--json', '--force'], FINISHED_HANDOFF).stdout,
    );

    // 3. It goes out as a file.
    const delivered = join(repo, 'delivered.md');
    assert.equal(handoff(repo, ['send', created.id, '--channel', 'file', '--to', delivered]).code, 0);

    // 4. The mobile developer's agent reads it in their own repository.
    const consumer = mkdtempSync(join(tmpdir(), 'handoff-loop-'));
    dirs.push(consumer);
    writeFileSync(join(consumer, 'HANDOFF.md'), readFileSync(delivered, 'utf8'));

    const received = handoff(consumer, ['receive', 'HANDOFF.md', '--as', 'mobile', '--json']);
    assert.equal(received.code, 0);
    const analysis = JSON.parse(received.stdout);
    assert.equal(analysis.applies, true);
    assert.equal(analysis.breaking, true);
    assert.equal(analysis.valid, true);
    assert.match(analysis.brief, /Request the `write` scope/);
    assert.match(analysis.brief, /Do not add a second token store/);
  });
});

describe('piping', () => {
  it('exits quietly when the reader closes the pipe', () => {
    // `handoff show <id> | head -1` is an ordinary thing to do, and it used to end in an
    // unhandled EPIPE stack trace.
    const result = spawnSync('bash', ['-c', `${process.execPath} ${BIN} help | head -1`], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(result.status, 0);
    assert.ok(!(result.stderr ?? '').includes('EPIPE'), result.stderr);
    assert.ok(!(result.stderr ?? '').includes('Unhandled'), result.stderr);
  });
});

describe('--no-input', () => {
  it('is accepted by every command without being declared', () => {
    for (const args of [['list'], ['config'], ['help']]) {
      const result = handoff(repo, [...args, '--no-input']);
      assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
    }
  });

  it('keeps a bare invocation on the help output rather than a menu', () => {
    const result = handoff(repo, ['--no-input']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage/);
  });
});

describe('generated skills stay current', () => {
  it('the committed SKILL.md files match what the generator produces', () => {
    // If this fails, the methodology changed and the skills were not regenerated:
    //   npm run skills
    const result = spawnSync(
      process.execPath,
      ['packages/integrations/claude-code/scripts/write-skills.mjs', '--check'],
      { cwd: resolve(here, '..', '..', '..', '..'), encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  });
});

describe('delivery does not launch anything under --no-open', () => {
  // A finished handoff, stored under its own id. A scaffold from `handoff create` is refused
  // by `send`, which is its own test below.
  function finished(id: string): string {
    const stored = JSON.parse(
      handoff(repo, ['create', '--stdin', '--json', '--force'], FINISHED_HANDOFF.replace(/^id: .*$/m, `id: ${id}`)).stdout,
    );
    return stored.id as string;
  }

  it('prints the link rather than opening it', () => {
    const id = finished('2026-08-28-openable');
    const result = handoff(repo, [
      'send', id, '--channel', 'whatsapp', '--to', '+905551112233', '--no-open',
    ]);
    assert.equal(result.code, 0, result.stderr);
    // Either scheme is correct: whatsapp:// where the desktop app is installed, wa.me
    // where it is not. What matters is that --no-open printed rather than launched.
    assert.match(result.stdout, /Open this to compose: /);
    assert.match(result.stdout, /905551112233/);
    // Nothing was opened and nothing left the machine: the line says the draft is ready.
    assert.doesNotMatch(result.stdout, /^(sent|opened) /m);
    assert.match(result.stdout, /^ready /m);
  });

  it('keeps a file copy with no --to out of the working tree', () => {
    const id = finished('2026-08-28-file-default');
    const before = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' }).stdout;
    const result = handoff(repo, ['send', id, '--channel', 'file']);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(existsSync(join(repo, '.handoff', 'outbox', `${id}.md`)), result.stdout);
    const after = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' }).stdout;
    assert.equal(after, before, 'the copy shows up as a file to commit');
  });

  it('opens the contact picker when no number is configured', () => {
    // Keeping colleagues' phone numbers in a config file is what this replaces: WhatsApp
    // documents `wa.me/?text=` as the form that opens a contact list to choose from.
    const id = finished('2026-08-28-no-number');
    const result = handoff(repo, [
      'send', id, '--channel', 'whatsapp', '--link', 'none', '--no-open',
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /https:\/\/wa\.me\/\?text=/);
  });

  it('refuses to send a scaffold that still has TODO markers', () => {
    const created = JSON.parse(
      handoff(repo, ['create', '--target', 'mobile', '--title', 'Still a template', '--json']).stdout,
    );
    const result = handoff(repo, ['send', created.id, '--channel', 'stdout']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /scaffold/);
  });
});

describe('handoff receive with a document written by someone hostile', () => {
  it('never lets the frontmatter id choose where the copy is written', () => {
    const consumer = mkdtempSync(join(tmpdir(), 'handoff-hostile-'));
    dirs.push(consumer);
    const name = `agents-handoff-cli-pwned-${process.pid}`;
    const escape = `/tmp/${name}`;
    rmSync(escape, { recursive: true, force: true });

    writeFileSync(
      join(consumer, 'incoming.md'),
      FINISHED_HANDOFF.replace(/^id: .*$/m, `id: ${'../'.repeat(12)}tmp/${name}`),
    );

    const result = handoff(consumer, ['receive', 'incoming.md', '--as', 'mobile']);

    assert.equal(existsSync(escape), false, `wrote outside the project: ${escape}`);
    rmSync(escape, { recursive: true, force: true });

    // The brief is the point of `receive`; a bad id must not cost the developer their read.
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /# Incoming handoff/);
    assert.match(result.stdout, /Request the `write` scope/);

    const inbox = join(consumer, '.handoff', 'inbox');
    const stored = existsSync(inbox) ? readdirSync(inbox) : [];
    for (const id of stored) assert.ok(!id.includes('..'), `unsafe inbox entry: ${id}`);
  });

  it('does not store a document that is not a conforming handoff', () => {
    const consumer = mkdtempSync(join(tmpdir(), 'handoff-nonconforming-'));
    dirs.push(consumer);
    writeFileSync(
      join(consumer, 'incoming.md'),
      FINISHED_HANDOFF.replace(/## Verification[\s\S]*?(?=## Instructions)/, ''),
    );

    const result = handoff(consumer, ['receive', 'incoming.md', '--as', 'mobile']);
    assert.match(result.stdout, /# Incoming handoff/);
    assert.equal(
      existsSync(join(consumer, '.handoff', 'inbox', '2026-08-28-scopes', 'HANDOFF.md')),
      false,
      'a non-conforming document must not be filed as though it were a handoff',
    );
    assert.match(result.stderr, /[Nn]ot stored/);
  });
});

describe('validate --json stays JSON', () => {
  it('answers a directory that holds no handoff with JSON and a failing exit code', () => {
    mkdirSync(join(repo, 'not-a-handoff'), { recursive: true });
    const result = handoff(repo, ['validate', 'not-a-handoff', '--json']);
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; error?: string };
    assert.equal(parsed.ok, false);
    assert.match(parsed.error ?? '', /No handoff matching/);
  });
});

describe('generated Claude Code skills', () => {
  // Claude Code drops every frontmatter field, silently, when the block does not parse:
  // `argument-hint: [target] [note]` once did exactly that.
  it('have frontmatter that parses, with the fields Claude Code reads', async () => {
    const { parse } = await import('yaml');
    const { generateSkills } = await import('agents-handoff-claude-code');
    for (const skill of generateSkills()) {
      const block = /^---\n([\s\S]*?)\n---\n/.exec(skill.contents)?.[1] ?? '';
      const meta = parse(block) as Record<string, unknown>;
      assert.equal(meta['name'], skill.name);
      assert.equal(typeof meta['description'], 'string');
      assert.equal(typeof meta['argument-hint'], 'string');
      // Opened when the developer asks in their own words, as in Codex; the description
      // limits it to that request.
      assert.notEqual(meta['disable-model-invocation'], true);
      assert.match(String(meta['allowed-tools']), /Bash\(handoff \*\)/);
    }
  });
});

describe('handoff receive and a credential in the document', () => {
  it('reads it but does not store it, and says what matched', () => {
    const consumer = mkdtempSync(join(tmpdir(), 'handoff-leaky-'));
    dirs.push(consumer);
    writeFileSync(
      join(consumer, 'incoming.md'),
      FINISHED_HANDOFF.replace('## Verification', '## Notes\n\nUse token ghp_abcdefghijklmnopqrstuvwxyz0123456789 to test.\n\n## Verification'),
    );

    const result = handoff(consumer, ['receive', 'incoming.md', '--as', 'mobile', '--json']);
    const parsed = JSON.parse(result.stdout) as { not_stored?: string[] | null; secrets?: unknown[] };
    assert.ok(parsed.not_stored?.includes('credential'), result.stdout);
    assert.ok((parsed.secrets ?? []).length > 0);
    assert.equal(existsSync(join(consumer, '.handoff', 'inbox')), false);
  });
});

describe('handoff send --list with no handoff named', () => {
  it('shows what is set up instead of a usage error', () => {
    const result = handoff(repo, ['send', '--list']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /clipboard/);
  });
});

describe('handoff install mcp without Claude Desktop', () => {
  it('writes nothing and says how to add the server instead', () => {
    const home = mkdtempSync(join(tmpdir(), 'handoff-home-'));
    dirs.push(home);
    const result = spawnSync(process.execPath, [BIN, 'install', 'mcp'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', HOME: home, APPDATA: join(home, 'AppData') },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Nothing was written/);
    assert.match(result.stderr, /claude mcp add agents-handoff -- npx -y agents-handoff-mcp/);
    assert.deepEqual(readdirSync(home), [], 'created a Claude Desktop directory for an app that is not there');
  });
});
