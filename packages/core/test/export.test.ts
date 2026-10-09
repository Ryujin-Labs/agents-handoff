import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { ExportHandoffError, exportHandoff } from '../src/export/index.ts';
import * as core from '../src/index.ts';
import { removeDir, tempDir, VALID_HANDOFF } from './helpers.ts';

// Export is a local file operation. Guard every test against the former desktop and
// remote delivery paths, including named ESM imports of these built-in functions.
const externalCalls: unknown[][] = [];
const forbidExternal = (...args: unknown[]): never => {
  externalCalls.push(args);
  throw new Error('Markdown export attempted an external operation');
};
for (const method of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'] as const) {
  mock.method(childProcess, method, forbidExternal as never);
}
mock.method(globalThis, 'fetch', forbidExternal as never);
mock.method(http, 'request', forbidExternal as never);
mock.method(http, 'get', forbidExternal as never);
mock.method(https, 'request', forbidExternal as never);
mock.method(https, 'get', forbidExternal as never);
mock.method(net, 'connect', forbidExternal as never);
mock.method(net, 'createConnection', forbidExternal as never);
syncBuiltinESMExports();

const dirs: string[] = [];
function project(): string {
  const dir = tempDir('handoff-export-test-');
  dirs.push(dir);
  return dir;
}

beforeEach(() => { externalCalls.length = 0; });
afterEach(() => assert.deepEqual(externalCalls, [], 'export attempted an app, process, or network operation'));
after(() => {
  try {
    for (const dir of dirs) removeDir(dir);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

const id = '2026-08-28-rate-limit';
const bytes = (path: string): Buffer => readFileSync(path);
const isPrivateFile = (path: string): void => {
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
};

describe('Markdown export', () => {
  it('exposes the file export API without the removed delivery and desktop APIs', () => {
    assert.equal(core.exportHandoff, exportHandoff);
    assert.equal(core.ExportHandoffError, ExportHandoffError);
    for (const name of [
      'BUILTIN_CHANNELS', 'findChannel', 'emailChannel', 'whatsappChannel',
      'deliveryOptions', 'openExternal', 'copyFileToClipboard',
    ]) {
      assert.equal(Object.hasOwn(core, name), false, `${name} remains a public API`);
    }
  });

  it('writes the complete handoff byte for byte, including Unicode, CRLF and no final newline', () => {
    const cwd = project();
    const markdown = (VALID_HANDOFF + '\n## Notes\n\nİstanbul — café ☕.\n').trimEnd().replace(/\n/g, '\r\n');
    const result = exportHandoff({ cwd, markdown });
    assert.equal(result.id, id);
    assert.equal(result.path, join(cwd, '.handoff', 'exports', `${id}.md`));
    assert.equal(result.markdown, markdown);
    assert.equal(result.unchanged, false);
    assert.deepEqual(bytes(result.path), Buffer.from(markdown, 'utf8'));
    assert.ok(!bytes(result.path).subarray(-2).equals(Buffer.from('\r\n')));
    assert.match(result.markdown, /status: ready/);
  });

  it('uses a chosen output filename relative to the project', () => {
    const cwd = project();
    const result = exportHandoff({ cwd, markdown: VALID_HANDOFF, outputPath: 'review/HANDOFF.md' });
    assert.equal(result.path, join(cwd, 'review', 'HANDOFF.md'));
    assert.deepEqual(bytes(result.path), Buffer.from(VALID_HANDOFF));
  });

  it('accepts a Markdown extension without depending on its case', () => {
    const cwd = project();
    const result = exportHandoff({ cwd, markdown: VALID_HANDOFF, outputPath: 'HANDOFF.MD' });
    assert.equal(result.path, join(cwd, 'HANDOFF.MD'));
    assert.deepEqual(bytes(result.path), Buffer.from(VALID_HANDOFF));
  });

  it('refuses a new output with a non-Markdown extension before creating its directory', () => {
    const cwd = project();
    assert.throws(() => exportHandoff({
      cwd, markdown: VALID_HANDOFF, outputPath: 'src/app.ts',
    }), ExportHandoffError);
    assert.equal(existsSync(join(cwd, 'src')), false);
  });

  it('uses the handoff id inside an existing output directory', () => {
    const cwd = project();
    const destination = join(cwd, 'review');
    mkdirSync(destination);
    const result = exportHandoff({ cwd, markdown: VALID_HANDOFF, outputPath: destination });
    assert.equal(result.path, join(destination, `${id}.md`));
    assert.deepEqual(bytes(result.path), Buffer.from(VALID_HANDOFF));
  });

  it('uses a configured export directory without changing the original handoff', () => {
    const cwd = project();
    const sourcePath = join(cwd, 'HANDOFF.md');
    writeFileSync(sourcePath, VALID_HANDOFF, { mode: 0o644 });
    const result = exportHandoff({ cwd, markdown: VALID_HANDOFF, sourcePath, exportDir: 'docs/exports' });
    assert.equal(result.path, join(cwd, 'docs', 'exports', `${id}.md`));
    assert.equal(result.sourcePath, sourcePath);
    assert.deepEqual(bytes(sourcePath), bytes(result.path));
    if (process.platform !== 'win32') assert.equal(statSync(sourcePath).mode & 0o777, 0o644);
  });

  it('treats the original source path as a no-op and preserves its permissions', () => {
    const cwd = project();
    const sourcePath = join(cwd, 'HANDOFF.md');
    writeFileSync(sourcePath, VALID_HANDOFF, { mode: 0o644 });
    const before = statSync(sourcePath);
    const result = exportHandoff({ cwd, markdown: VALID_HANDOFF, sourcePath, outputPath: sourcePath });
    assert.equal(result.path, sourcePath);
    assert.equal(result.sourcePath, sourcePath);
    assert.equal(result.unchanged, true);
    assert.deepEqual(bytes(sourcePath), Buffer.from(VALID_HANDOFF));
    assert.equal(statSync(sourcePath).mtimeMs, before.mtimeMs);
    assert.equal(statSync(sourcePath).mode, before.mode);
  });

  it('refuses to replace the original source after its contents change', () => {
    const cwd = project();
    const sourcePath = join(cwd, 'HANDOFF.md');
    const changed = VALID_HANDOFF.replace('Previous: unlimited.', 'Previous: one request.');
    writeFileSync(sourcePath, changed);
    assert.throws(() => exportHandoff({
      cwd, markdown: VALID_HANDOFF, sourcePath, outputPath: sourcePath,
    }), ExportHandoffError);
    assert.deepEqual(bytes(sourcePath), Buffer.from(changed));
  });

  it('refuses to recreate a source file removed since it was read', () => {
    const cwd = project();
    const sourcePath = join(cwd, 'removed.md');
    assert.throws(() => exportHandoff({
      cwd, markdown: VALID_HANDOFF, sourcePath, outputPath: sourcePath,
    }), ExportHandoffError);
    assert.equal(existsSync(sourcePath), false);
  });

  it('refuses stale source bytes before creating a separate export copy', () => {
    const cwd = project();
    const sourcePath = join(cwd, 'HANDOFF.md');
    const changed = VALID_HANDOFF.replace('Previous: unlimited.', 'Previous: one request.');
    writeFileSync(sourcePath, changed);
    assert.throws(() => exportHandoff({
      cwd, markdown: VALID_HANDOFF, sourcePath, outputPath: 'review/copy.md',
    }), ExportHandoffError);
    assert.equal(existsSync(join(cwd, 'review')), false);
    assert.deepEqual(bytes(sourcePath), Buffer.from(changed));
  });

  it('keeps an unchanged source alias read-only when the output names its real file', () => {
    const cwd = project();
    const original = join(cwd, 'HANDOFF.md');
    const sourcePath = join(cwd, 'source-alias.md');
    writeFileSync(original, VALID_HANDOFF, { mode: 0o644 });
    symlinkSync(original, sourcePath);
    const before = statSync(original);
    const result = exportHandoff({
      cwd, markdown: VALID_HANDOFF, sourcePath, outputPath: original,
    });
    assert.equal(result.unchanged, true);
    assert.equal(result.path, original);
    assert.equal(statSync(original).mtimeMs, before.mtimeMs);
    assert.equal(statSync(original).mode, before.mode);
    assert.equal(lstatSync(sourcePath).isSymbolicLink(), true);
  });

  it('refreshes an existing copy only for the same id and source project', () => {
    const cwd = project();
    const first = exportHandoff({ cwd, markdown: VALID_HANDOFF });
    const markdown = VALID_HANDOFF.replace('Previous: unlimited.', 'Previous: 100 requests per minute.');
    const refresh = exportHandoff({ cwd, markdown });
    assert.equal(refresh.path, first.path);
    assert.deepEqual(bytes(refresh.path), Buffer.from(markdown));
  });

  it('refuses an unrelated existing file without modifying it', () => {
    const cwd = project();
    const path = join(cwd, 'app.ts');
    const original = 'export const keep = true;\n';
    writeFileSync(path, original);
    assert.throws(() => exportHandoff({ cwd, markdown: VALID_HANDOFF, outputPath: path }), ExportHandoffError);
    assert.equal(readFileSync(path, 'utf8'), original);
  });

  it('refuses a same-id handoff from a different source project', () => {
    const cwd = project();
    const original = exportHandoff({ cwd, markdown: VALID_HANDOFF });
    const markdown = VALID_HANDOFF.replace('  project: backend', '  project: other-team');
    assert.throws(() => exportHandoff({ cwd, markdown }), ExportHandoffError);
    assert.deepEqual(bytes(original.path), Buffer.from(VALID_HANDOFF));
  });

  it('refuses a different handoff id at the chosen output path', () => {
    const cwd = project();
    const original = exportHandoff({ cwd, markdown: VALID_HANDOFF });
    const markdown = VALID_HANDOFF.replace(`id: ${id}`, 'id: 2026-08-28-other-handoff');
    assert.throws(() => exportHandoff({ cwd, markdown, outputPath: original.path }), ExportHandoffError);
    assert.deepEqual(bytes(original.path), Buffer.from(VALID_HANDOFF));
  });
});

describe('safe export paths', () => {
  it('refuses a file symlink even when its target contains the same handoff', () => {
    const cwd = project();
    const source = join(cwd, 'original.md');
    const link = join(cwd, 'linked.md');
    writeFileSync(source, VALID_HANDOFF);
    symlinkSync(source, link);
    const markdown = VALID_HANDOFF.replace('Previous: unlimited.', 'Previous: one request.');
    assert.throws(() => exportHandoff({ cwd, markdown, outputPath: link }), ExportHandoffError);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(bytes(source), Buffer.from(VALID_HANDOFF));
  });

  it('refuses a dangling file symlink without creating its target', () => {
    const cwd = project();
    const target = join(cwd, 'missing.md');
    const link = join(cwd, 'linked.md');
    symlinkSync(target, link);
    assert.throws(() => exportHandoff({ cwd, markdown: VALID_HANDOFF, outputPath: link }), ExportHandoffError);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(existsSync(target), false);
  });

  it('refuses a symlink in the output directory path without writing outside the project', () => {
    const cwd = project();
    const outside = project();
    symlinkSync(outside, join(cwd, 'exports'), 'dir');
    assert.throws(() => exportHandoff({ cwd, markdown: VALID_HANDOFF, outputPath: 'exports/nested/HANDOFF.md' }), ExportHandoffError);
    assert.equal(existsSync(join(outside, 'nested')), false);
  });

  it('refuses a symlink replacing the default handoff directory', () => {
    const cwd = project();
    const outside = project();
    symlinkSync(outside, join(cwd, '.handoff'), 'dir');
    assert.throws(() => exportHandoff({ cwd, markdown: VALID_HANDOFF }), ExportHandoffError);
    assert.equal(existsSync(join(outside, 'exports')), false);
  });

  it('creates private output directories and a private Markdown file', () => {
    const cwd = project();
    const result = exportHandoff({ cwd, markdown: VALID_HANDOFF });
    isPrivateFile(result.path);
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(cwd, '.handoff')).mode & 0o777, 0o700);
      assert.equal(statSync(join(cwd, '.handoff', 'exports')).mode & 0o777, 0o700);
    }
    assert.match(readFileSync(join(cwd, '.handoff', 'exports', '.gitignore'), 'utf8'), /^\*$/m);
  });

  it('keeps an existing user directory permission unchanged and makes the copy private', () => {
    const cwd = project();
    const output = join(cwd, 'shared');
    mkdirSync(output, { mode: 0o755 });
    chmodSync(output, 0o755);
    const before = statSync(output).mode;
    const result = exportHandoff({ cwd, markdown: VALID_HANDOFF, outputPath: output });
    assert.equal(statSync(output).mode, before);
    isPrivateFile(result.path);
  });
});

describe('export validation', () => {
  it('refuses malformed handoffs before creating any output', () => {
    const cwd = project();
    assert.throws(() => exportHandoff({ cwd, markdown: '# Plain notes\n' }), ExportHandoffError);
    assert.equal(existsSync(join(cwd, '.handoff')), false);
  });

  it('refuses a scaffold without presenting it as a completed handoff', () => {
    const cwd = project();
    const markdown = VALID_HANDOFF.replace('status: ready', 'status: draft').replace(
      '`GET /search` now returns 429 after 30 requests per minute per user.',
      '<!-- TODO --> write the summary.',
    );
    assert.throws(() => exportHandoff({ cwd, markdown }), ExportHandoffError);
    assert.equal(existsSync(join(cwd, '.handoff')), false);
  });

  it('refuses a ready handoff that still has an actual scaffold marker', () => {
    const cwd = project();
    const markdown = VALID_HANDOFF.replace(
      '`GET /search` now returns 429 after 30 requests per minute per user.',
      '<!-- TODO --> write the summary.',
    );
    assert.throws(() => exportHandoff({ cwd, markdown }), ExportHandoffError);
    assert.equal(existsSync(join(cwd, '.handoff')), false);
  });

  it('refuses credential-shaped content without writing or exposing it in the error', () => {
    const cwd = project();
    const credential = 'Tr0ub4dor3horse';
    const markdown = `${VALID_HANDOFF}\n## Notes\n\nDB_PASSWORD=${credential}\n`;
    assert.throws(() => exportHandoff({ cwd, markdown }), (error: unknown) => {
      assert.ok(error instanceof ExportHandoffError);
      assert.ok(!error.message.includes(credential));
      return true;
    });
    assert.equal(existsSync(join(cwd, '.handoff')), false);
  });

  it('does not expose credentials through a parse error for malformed Markdown', () => {
    const cwd = project();
    const credential = 'Tr0ub4dor3horse';
    const markdown = `---\nDB_PASSWORD=${credential}\ninvalid: [unterminated\n---\n`;
    assert.throws(() => exportHandoff({ cwd, markdown }), (error: unknown) => {
      assert.ok(error instanceof ExportHandoffError);
      assert.ok(!error.message.includes(credential));
      return true;
    });
    assert.equal(existsSync(join(cwd, '.handoff')), false);
  });
});
