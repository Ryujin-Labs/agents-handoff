import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it, mock } from 'node:test';
import { emailChannel } from '../src/channels/remote.ts';
import { parseHandoff } from '../src/markdown/parse.ts';
import { canOpen, openExternal } from '../src/util/desktop.ts';
import { VALID_HANDOFF } from './helpers.ts';

// Exercise failure reporting without launching a client, opening Finder, changing the
// clipboard, or relying on a desktop application being installed on the test machine.
const calls: Array<{ command: string; args: readonly string[] }> = [];
mock.method(childProcess, 'spawnSync', ((command: string, args?: readonly string[]) => {
  calls.push({ command, args: Array.isArray(args) ? args : [] });
  return { pid: 0, output: [null, null, null], stdout: '', stderr: '', status: 1, signal: null };
}) as typeof childProcess.spawnSync);
syncBuiltinESMExports();

const dirs: string[] = [];
beforeEach(() => { calls.length = 0; });
after(() => {
  try {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

function outbox(): { cwd: string; stagingDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'handoff-desktop-test-'));
  dirs.push(cwd);
  return { cwd, stagingDir: join(cwd, '.handoff', 'outbox') };
}

describe('desktop delivery failures', () => {
  it('reports an unsuccessful opener instead of claiming an app opened', () => {
    const target = 'mailto:?subject=Handoff%3A%20Test';
    const result = openExternal(target);
    assert.equal(result.ok, false);
    assert.ok(result.error);
    if (canOpen()) {
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.args.at(-1), target);
    }
  });

  it('keeps the complete export usable when revealing and opening both fail', async () => {
    const paths = outbox();
    const handoff = parseHandoff(VALID_HANDOFF);
    const result = await emailChannel.send({
      ...paths,
      handoff,
      markdown: VALID_HANDOFF,
      link: 'none',
      open: true,
    });

    assert.equal(result.ok, true, result.message);
    assert.equal(result.opened, false);
    assert.equal(result.exportedPath, join(paths.stagingDir, `${handoff.frontmatter.id}.md`));
    assert.equal(readFileSync(result.exportedPath ?? '', 'utf8'), VALID_HANDOFF);
    assert.ok(result.nextStep?.includes(result.exportedPath ?? ''), result.nextStep);
    assert.match(result.nextStep ?? '', /Attach .+ before sending/);
    assert.match(result.message, /no file is attached automatically/i);
    assert.doesNotMatch(result.message, /(?:showing|shown) in Finder|one paste attaches/i);
  });

  it('exports under no-open without touching any desktop integration', async () => {
    const paths = outbox();
    const result = await emailChannel.send({
      ...paths,
      handoff: parseHandoff(VALID_HANDOFF),
      markdown: VALID_HANDOFF,
      link: 'none',
      open: false,
    });

    assert.equal(result.ok, true, result.message);
    assert.equal(result.opened, false);
    assert.equal(readFileSync(result.exportedPath ?? '', 'utf8'), VALID_HANDOFF);
    assert.deepEqual(calls, [], 'no-open attempted a desktop operation');
  });
});
