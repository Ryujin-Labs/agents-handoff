import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_BIN = resolve(here, '..', 'src', 'bin.js');

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

/**
 * A minimal MCP client speaking JSON-RPC over stdio.
 *
 * Hand-written rather than pulled from the SDK's client on purpose: these tests should
 * fail if the wire format changes, not quietly keep passing because both sides moved
 * together.
 */
export class TestClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  readonly stderr: string[] = [];

  constructor(args: string[] = []) {
    this.child = spawn(process.execPath, [SERVER_BIN, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message: string };
      };
      if (typeof message.id !== 'number') continue;
      const waiting = this.pending.get(message.id);
      if (!waiting) continue;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result ?? {});
    }
  }

  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${method} timed out. stderr: ${this.stderr.join('')}`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize(): Promise<Record<string, unknown>> {
    const result = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'handoff-test', version: '1' },
    });
    this.notify('notifications/initialized');
    return result;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallResult> {
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    return {
      text: (result.content ?? []).map((part) => part.text ?? '').join('\n'),
      isError: result.isError === true,
      structured: result.structuredContent,
    };
  }

  close(): void {
    this.child.kill();
  }
}

export interface CallResult {
  text: string;
  isError: boolean;
  structured?: Record<string, unknown> | undefined;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A repository with an auth change worth handing off. */
export function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-mcp-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'package.json'), '{"name":"svc","scripts":{"test":"jest"}}\n');
  writeFileSync(join(dir, 'routes.js'), "router.post('/messages', handler);\n");
  writeFileSync(join(dir, 'types.js'), '// @property {string} id\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);

  git(dir, ['checkout', '-q', '-b', 'feature/scopes']);
  writeFileSync(
    join(dir, 'routes.js'),
    "router.post('/messages', requirePermission('messages:write'), handler);\n",
  );
  writeFileSync(join(dir, 'types.js'), '// @property {string} messageId\n');
  writeFileSync(join(dir, 'migration.sql'), 'ALTER TABLE messages DROP COLUMN legacy_id;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'Require messages:write']);
  return dir;
}

/** The minimum a valid handoff needs, so tests can vary one field at a time. */
export function writeArgs(projectDir: string, overrides: Record<string, unknown> = {}) {
  return {
    project_dir: projectDir,
    title: 'Messages need the write scope',
    targets: ['mobile'],
    breaking: true,
    change_type: ['api', 'authorization'],
    summary: 'POST /messages now requires the messages:write scope and returns 201.',
    why_this_matters: 'Existing tokens lack the scope, so every send fails with 403.',
    changes: 'Previous: any valid token, 200. New: messages:write required, 201.',
    required_actions: '1. Request the messages:write scope at login.\n2. Handle 403 distinctly.',
    breaking_changes: 'Builds without the scope lose message sending entirely.',
    verification: 'Send with a scoped token, then an unscoped one.',
    instructions_for_receiving_agent:
      'Modify the existing auth request. Do not add a second token store.',
    ...overrides,
  };
}
