import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTextFile } from '../src/util/fs.ts';

/** A throwaway directory that the caller is responsible for removing. */
export function tempDir(prefix = 'agents-handoff-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Initialize a git repository with deterministic identity and no global config leaking in. */
export function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, contents] of Object.entries(files)) {
    writeTextFile(join(dir, path), contents);
  }
}

export function commitAll(dir: string, message: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

/**
 * A repository with a `main` commit and a feature branch containing an API change, an auth
 * guard, a migration, a renamed type field and a new environment variable. Several tests
 * assert against this same fixture, so it is worth having exactly one of it.
 */
export function scenarioRepo(): string {
  const dir = tempDir();
  initRepo(dir);
  writeFiles(dir, {
    'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'vitest run' } }, null, 2),
    'src/routes/messages.ts': [
      "import { Router } from 'express';",
      'const router = Router();',
      "router.post('/messages', async (req, res) => { res.json({ id: '1' }); });",
      "router.get('/messages/:id', async (req, res) => { res.json({}); });",
      'export default router;',
    ].join('\n'),
    'types/message.ts': 'export interface Message {\n  id: string;\n  body: string;\n}\n',
  });
  commitAll(dir, 'initial');

  git(dir, ['checkout', '-q', '-b', 'feature/message-auth']);
  writeFiles(dir, {
    'src/auth/require-permission.ts': [
      'export function requirePermission(scope: string) {',
      '  return (req: any, res: any, next: any) => {',
      "    if (!req.user?.scopes?.includes(scope)) return res.status(403).json({ error: 'forbidden' });",
      '    next();',
      '  };',
      '}',
    ].join('\n'),
    'src/routes/messages.ts': [
      "import { Router } from 'express';",
      "import { requirePermission } from '../auth/require-permission';",
      'const router = Router();',
      "router.post('/messages', requirePermission('messages:write'), async (req, res) => {",
      '  const days = process.env.MESSAGE_RETENTION_DAYS;',
      "  res.status(201).json({ messageId: '1', retentionDays: days });",
      '});',
      'export default router;',
    ].join('\n'),
    'types/message.ts': 'export interface Message {\n  messageId: string;\n  body: string;\n  retentionDays: number;\n}\n',
    'migrations/002_retention.sql': [
      'ALTER TABLE messages ADD COLUMN retention_days INT NOT NULL DEFAULT 30;',
      'ALTER TABLE messages DROP COLUMN legacy_id;',
    ].join('\n'),
    'dist/bundle.js': 'console.log("build output that must be ignored");',
  });
  commitAll(dir, 'Require messages:write and add retention');
  return dir;
}

/** A minimal conforming handoff document, used wherever a valid input is needed. */
export const VALID_HANDOFF = `---
handoff_version: 1
id: 2026-08-28-rate-limit
title: Rate limiting on /search
created_at: 2026-08-28T18:20:00Z
status: ready
breaking: false
source:
  project: backend
  branch: main
targets:
  - web
change_type:
  - api
---

# Rate limiting on /search

## Summary

\`GET /search\` now returns 429 after 30 requests per minute per user.

## Why This Matters

The web client retries immediately, which turns one rate-limit into a retry storm.

## Changes

Previous: unlimited. New: 30 req/min, then 429 with \`Retry-After\`.

## Required Actions

1. Handle 429 distinctly from 5xx.
2. Respect \`Retry-After\`.

## Verification

Send 31 searches in a minute and confirm the throttled state appears.

## Instructions for Receiving Agent

Modify the existing search request wrapper. Do not add a new HTTP client.
`;
