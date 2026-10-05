import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { after, describe, it } from 'node:test';
import { main } from '../src/cli.ts';
import { setSession } from '../src/session.ts';
import type { PromptIO } from '../src/prompt/index.ts';

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const ENTER = '\r';
const SPACE = ' ';
const CTRL_C = '\u0003';

const dirs: string[] = [];
after(() => {
  setSession({ interactive: false });
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A repository with a branch worth handing off. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-interactive-'));
  dirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'package.json'), '{"name":"svc","scripts":{"test":"jest"}}\n');
  writeFileSync(join(dir, 'routes.js'), "r.post('/messages', h);\n");
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);

  git(dir, ['checkout', '-q', '-b', 'feature/scopes']);
  writeFileSync(join(dir, 'routes.js'), "r.post('/messages', guard('write'), h);\n");
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'add guard']);
  return dir;
}

interface Run {
  code: number;
  output: string;
}

/**
 * Run the CLI with prompting forced on and a scripted keyboard.
 *
 * This is the only way to exercise the interactive flows without a pseudo-terminal, and it
 * covers the part unit tests cannot: that each flow assembles arguments the real commands
 * actually understand.
 */
async function run(cwd: string, argv: string[], keys: string[]): Promise<Run> {
  const input = new PassThrough() as PassThrough & { setRawMode?: (m: boolean) => void };
  input.setRawMode = () => {};
  let written = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      written += String(chunk);
      callback();
    },
  });
  const io: PromptIO = { input, output, columns: 100 };

  let index = 0;
  const tick = setInterval(() => {
    if (index < keys.length) input.write(keys[index++]);
    else clearInterval(tick);
  }, 4);

  try {
    const code = await main(argv, cwd, { interactive: true, io });
    return { code, output: written.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '') };
  } finally {
    clearInterval(tick);
    setSession({ interactive: false });
  }
}

describe('interactive create', () => {
  it('walks scope, targets and title, then writes the draft', async () => {
    const repo = makeRepo();
    const result = await run(repo, ['create'], [
      ENTER, // scope: everything on this branch since main
      SPACE, // target: first option
      ENTER, // confirm targets
      ENTER, // accept the suggested title
      ENTER, // confirm creation
      ENTER, // "I'll fill it in myself"
    ]);

    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /What should this handoff cover\?/);
    assert.match(result.output, /Who is this handoff for\?/);
    assert.match(result.output, /Title\?/);

    const created = readdirSync(join(repo, '.handoff')).filter((name) => name !== 'inbox');
    assert.equal(created.length, 1, 'exactly one handoff should exist');
    const document = readFileSync(join(repo, '.handoff', created[0] ?? '', 'HANDOFF.md'), 'utf8');
    assert.match(document, /^handoff_version: 1$/m);
    assert.match(document, /^status: draft$/m);
    assert.match(document, /branch: feature\/scopes/);
  });

  it('passes the chosen target through to the document', async () => {
    const repo = makeRepo();
    await run(repo, ['create'], [ENTER, SPACE, ENTER, ENTER, ENTER, ENTER]);
    const created = readdirSync(join(repo, '.handoff')).filter((n) => n !== 'inbox');
    const document = readFileSync(join(repo, '.handoff', created[0] ?? '', 'HANDOFF.md'), 'utf8');
    // The first offered target is the first of the built-in suggestions.
    assert.match(document, /^targets:\n {2}- \w+/m);
  });

  it('writes nothing when the confirmation is declined', async () => {
    const repo = makeRepo();
    const result = await run(repo, ['create'], [
      ENTER, // scope
      ENTER, // no targets
      ENTER, // title
      DOWN,
      ENTER, // decline "Create the draft?"
    ]);
    assert.equal(result.code, 0);
    assert.match(result.output, /Nothing created/);
    assert.ok(!existsSync(join(repo, '.handoff')) || readdirSync(join(repo, '.handoff')).length === 0);
  });

  it('exits 130 and writes nothing when cancelled', async () => {
    const repo = makeRepo();
    const result = await run(repo, ['create'], [CTRL_C]);
    assert.equal(result.code, 130);
    assert.ok(!existsSync(join(repo, '.handoff')) || readdirSync(join(repo, '.handoff')).length === 0);
  });

  it('does not prompt when flags were given', async () => {
    const repo = makeRepo();
    const result = await run(repo, ['create', '--target', 'mobile', '--title', 'Flagged'], []);
    assert.equal(result.code, 0);
    assert.ok(!result.output.includes('What should this handoff cover?'));
    const created = readdirSync(join(repo, '.handoff')).filter((n) => n !== 'inbox');
    assert.match(readFileSync(join(repo, '.handoff', created[0] ?? '', 'HANDOFF.md'), 'utf8'), /Flagged/);
  });
});

describe('interactive init', () => {
  it('collects settings and writes the config', async () => {
    const repo = makeRepo();
    const result = await run(repo, ['init'], [
      ENTER, // project name default
      SPACE, // first target
      DOWN,
      SPACE, // second target
      ENTER, // confirm targets
      ENTER, // "anyone else?" -> skip
      ENTER, // language: English
      ENTER, // commit handoffs: yes
      DOWN,
      ENTER, // install skills: no
    ]);

    assert.equal(result.code, 0, result.output);
    const config = JSON.parse(readFileSync(join(repo, 'handoff.config.json'), 'utf8'));
    assert.equal(config.language, null, 'English default stores null');
    assert.equal(config.gitignore, false, 'committing handoffs means not gitignored');
    assert.equal(config.targets.length, 2);
    assert.ok(!existsSync(join(repo, '.claude', 'skills')), 'skills were declined');
  });

  it('records a non-English language when one is chosen', async () => {
    const repo = makeRepo();
    await run(repo, ['init'], [
      ENTER, // project
      ENTER, // no targets
      ENTER, // anyone else
      DOWN,
      ENTER, // language: something else
      'T', 'u', 'r', 'k', 'i', 's', 'h', ENTER,
      ENTER, // commit handoffs
      DOWN,
      ENTER, // no skills
    ]);
    const config = JSON.parse(readFileSync(join(repo, 'handoff.config.json'), 'utf8'));
    assert.equal(config.language, 'Turkish');
  });

  it('gitignores the directory when handoffs are kept local', async () => {
    const repo = makeRepo();
    await run(repo, ['init'], [
      ENTER,
      ENTER,
      ENTER,
      ENTER, // language English
      DOWN,
      ENTER, // keep local
      DOWN,
      ENTER, // no skills
    ]);
    const config = JSON.parse(readFileSync(join(repo, 'handoff.config.json'), 'utf8'));
    assert.equal(config.gitignore, true);
    assert.match(readFileSync(join(repo, '.gitignore'), 'utf8'), /\.handoff\//);
  });
});

describe('interactive send', () => {
  it('picks a handoff and a channel', async () => {
    const repo = makeRepo();
    // A finished handoff: `send` refuses a scaffold, so one straight from `create` would
    // test the refusal rather than the picker.
    mkdirSync(join(repo, '.handoff', '2026-08-28-sendable'), { recursive: true });
    writeFileSync(
      join(repo, '.handoff', '2026-08-28-sendable', 'HANDOFF.md'),
      [
        '---',
        'handoff_version: 1',
        'id: 2026-08-28-sendable',
        'created_at: 2026-08-28T10:00:00Z',
        'status: ready',
        'breaking: false',
        'source:',
        '  project: backend',
        'targets: [mobile]',
        'change_type: [api]',
        '---',
        '',
        '# Sendable',
        '',
        '## Summary',
        '',
        'Search results are now paginated.',
        '',
        '## Why This Matters',
        '',
        'Clients that read the whole list get only the first page.',
        '',
        '## Changes',
        '',
        '`GET /search` returns `{ items, cursor }`.',
        '',
        '## Required Actions',
        '',
        '1. Follow `cursor` until it is null.',
        '',
        '## Verification',
        '',
        'Search for a term with more than one page of results.',
        '',
        '## Instructions for Receiving Agent',
        '',
        'Extend the existing search client.',
        '',
      ].join('\n'),
    );

    const result = await run(repo, ['send'], [
      ENTER, // the only handoff
      DOWN,
      ENTER, // channel: second in the list (file)
      ENTER, // accept the default path
    ]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Which handoff do you want to send\?/);
    assert.match(result.output, /Send it where\?/);
  });

  it('does not prompt when only flags were given', async () => {
    const repo = makeRepo();
    const result = await run(repo, ['send', '--list'], []);
    assert.equal(result.code, 0, result.output);
    assert.ok(!result.output.includes('Which handoff do you want to send?'), result.output);
  });

  it('says so plainly when there is nothing to send', async () => {
    const repo = makeRepo();
    const result = await run(repo, ['send'], []);
    assert.equal(result.code, 0);
    assert.match(result.output, /No handoffs here yet/);
  });
});

describe('interactive receive', () => {
  it('offers a nearby handoff file and narrows to a target', async () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, 'INCOMING.md'),
      [
        '---',
        'handoff_version: 1',
        'id: 2026-08-28-incoming',
        'title: Incoming change',
        'created_at: 2026-08-28T10:00:00Z',
        'status: ready',
        'breaking: false',
        'source:',
        '  project: backend',
        'targets:',
        '  - mobile',
        'change_type:',
        '  - api',
        '---',
        '',
        '# Incoming change',
        '',
        '## Summary',
        '',
        'Something changed.',
        '',
        '## Why This Matters',
        '',
        'It affects you.',
        '',
        '## Changes',
        '',
        'Previous: a. New: b.',
        '',
        '## Required Actions',
        '',
        '1. Do the thing.',
        '',
        '## Verification',
        '',
        'Check the thing.',
        '',
        '## Instructions for Receiving Agent',
        '',
        'Modify the existing path. Do not add a second one.',
        '',
      ].join('\n'),
    );

    const result = await run(repo, ['receive'], [
      ENTER, // the discovered file
      ENTER, // first target
    ]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Which file did they send you\?/);
    assert.match(result.output, /INCOMING\.md/);
  });

  it('does not prompt when only flags were given', async () => {
    const repo = makeRepo();
    const result = await run(repo, ['receive', '--as', 'mobile'], []);
    assert.notEqual(result.code, 0);
    assert.ok(!result.output.includes('Which file did they send you?'), result.output);
  });

  it('does not prompt when a path was given', async () => {
    const repo = makeRepo();
    const result = await run(repo, ['receive', 'missing.md'], []);
    assert.equal(result.code, 1);
    assert.ok(!result.output.includes('Which file did they send you?'));
  });
});

describe('the bare command', () => {
  it('opens a menu on a terminal and quits cleanly', async () => {
    const repo = makeRepo();
    const result = await run(repo, [], [UP, ENTER]); // wrap to the last entry: Quit
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /What do you want to do\?/);
    assert.match(result.output, /Write a handoff/);
  });

  it('exits 130 on ctrl+c', async () => {
    const repo = makeRepo();
    assert.equal((await run(repo, [], [CTRL_C])).code, 130);
  });
});
