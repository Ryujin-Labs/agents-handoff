import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parseHandoff } from 'ryujin-handoff-core';
import { makeRepo, SERVER_BIN, TestClient, writeArgs } from './client.ts';

const repo = makeRepo();
const dirs = [repo];
let client: TestClient;

before(async () => {
  client = new TestClient();
  await client.initialize();
});

after(() => {
  client.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('handshake', () => {
  it('advertises tools and prompts', async () => {
    const fresh = new TestClient();
    try {
      const result = (await fresh.initialize()) as {
        capabilities: Record<string, unknown>;
        serverInfo: { name: string; version: string };
      };
      assert.ok(result.capabilities['tools']);
      assert.ok(result.capabilities['prompts']);
      assert.equal(result.serverInfo.name, 'agents-handoff');
    } finally {
      fresh.close();
    }
  });

  it('lists every tool with a description and a schema', async () => {
    const result = (await client.request('tools/list')) as {
      tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
    };
    const names = result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'handoff_context',
      'handoff_deliver',
      'handoff_delivery_options',
      'handoff_list',
      'handoff_read',
      'handoff_receive',
      'handoff_setup',
      'handoff_source',
      'handoff_validate',
      'handoff_write',
    ]);
    for (const tool of result.tools) {
      assert.ok((tool.description ?? '').length > 40, `${tool.name} needs a real description`);
      assert.equal(tool.inputSchema['type'], 'object');
    }
  });

  it('exposes both prompts with arguments', async () => {
    const result = (await client.request('prompts/list')) as {
      prompts: Array<{ name: string; arguments?: Array<{ name: string }> }>;
    };
    const names = result.prompts.map((prompt) => prompt.name).sort();
    assert.deepEqual(names, ['handoff', 'handoff-receive']);
    const handoff = result.prompts.find((prompt) => prompt.name === 'handoff');
    assert.ok(handoff?.arguments?.some((argument) => argument.name === 'target'));
  });

  it('returns the methodology when a prompt is fetched', async () => {
    const result = (await client.request('prompts/get', {
      name: 'handoff',
      arguments: { target: 'mobile', project_dir: repo },
    })) as { messages: Array<{ content: { text: string } }> };
    const text = result.messages[0]?.content.text ?? '';
    assert.match(text, /handoff_context/);
    assert.match(text, /handoff_write/);
    assert.match(text, /regex matches, not findings/);
    assert.match(text, /mobile/);
  });
});

describe('handoff_context', () => {
  it('returns the brief and structured data', async () => {
    const result = await client.callTool('handoff_context', {
      project_dir: repo,
      target: 'mobile',
    });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /# Handoff Context Brief/);
    assert.match(result.text, /routes\.js/);
    assert.match(result.text, /targets: mobile/);
    assert.ok(Array.isArray(result.structured?.['changed_files']));
  });

  it('flags the dropped column as a candidate, not a verdict', async () => {
    const result = await client.callTool('handoff_context', { project_dir: repo });
    assert.match(result.text, /Pattern matches only/);
    assert.match(result.text, /legacy_id/);
  });

  it('refuses a relative project_dir', async () => {
    const result = await client.callTool('handoff_context', { project_dir: './somewhere' });
    assert.equal(result.isError, true);
    assert.match(result.text, /absolute path/);
  });

  it('refuses a directory that does not exist', async () => {
    const result = await client.callTool('handoff_context', { project_dir: '/no/such/dir' });
    assert.equal(result.isError, true);
    assert.match(result.text, /No such directory/);
  });
});

describe('handoff_source', () => {
  it('reads files as they stand', async () => {
    const result = await client.callTool('handoff_source', {
      project_dir: repo,
      paths: ['routes.js'],
    });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /requirePermission/);
  });

  it('returns a diff when asked', async () => {
    const result = await client.callTool('handoff_source', {
      project_dir: repo,
      paths: ['routes.js'],
      mode: 'diff',
      base: 'main',
    });
    assert.match(result.text, /^\+.*requirePermission/m);
    assert.match(result.text, /^-.*router\.post/m);
  });

  it('refuses to escape the project', async () => {
    const result = await client.callTool('handoff_source', {
      project_dir: repo,
      paths: ['../../etc/passwd'],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /outside/);
  });

  it('refuses a secrets file even inside the project', async () => {
    writeFileSync(join(repo, '.env'), 'SECRET=abc\n');
    const result = await client.callTool('handoff_source', {
      project_dir: repo,
      paths: ['.env'],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /secrets file/);
    rmSync(join(repo, '.env'));
  });

  it('still allows .env.example, which carries no secret', async () => {
    writeFileSync(join(repo, '.env.example'), 'SECRET=\n');
    const result = await client.callTool('handoff_source', {
      project_dir: repo,
      paths: ['.env.example'],
    });
    assert.equal(result.isError, false, result.text);
    rmSync(join(repo, '.env.example'));
  });
});

describe('handoff_write', () => {
  it('writes a finished document with no TODO markers', async () => {
    const result = await client.callTool('handoff_write', writeArgs(repo));
    assert.equal(result.isError, false, result.text);

    const path = result.structured?.['path'] as string;
    assert.ok(existsSync(path));
    const document = readFileSync(path, 'utf8');

    assert.ok(!document.includes('TODO'), 'a written handoff must never contain a TODO');
    assert.match(document, /^status: ready$/m);
    assert.match(document, /^breaking: true$/m);
    assert.match(document, /## Required Actions/);
    assert.match(document, /Request the messages:write scope/);
  });

  it('takes the facts from git rather than from the caller', async () => {
    const result = await client.callTool(
      'handoff_write',
      writeArgs(repo, { id: 'facts-check', overwrite: true }),
    );
    const document = readFileSync(result.structured?.['path'] as string, 'utf8');
    assert.match(document, /branch: feature\/scopes/);
    assert.match(document, /^handoff_version: 1$/m);
    // Numeric-only short SHAs are quoted by YAML to preserve their string type.
    // Check the parsed value against git rather than depending on YAML's spelling.
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(parseHandoff(document).frontmatter.source.commit, commit);
    assert.match(document, /generated_by: .*\(mcp\)/);
  });

  it('refuses to store a document that does not conform, and says why', async () => {
    const result = await client.callTool(
      'handoff_write',
      writeArgs(repo, { id: 'no-breaking-section', breaking: true, breaking_changes: undefined }),
    );
    assert.equal(result.isError, true);
    assert.match(result.text, /Breaking Changes/);
    assert.match(result.text, /Not stored/);
  });

  it('refuses a document carrying a credential', async () => {
    const result = await client.callTool(
      'handoff_write',
      writeArgs(repo, {
        id: 'leaky',
        notes: 'Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 to test.',
      }),
    );
    assert.equal(result.isError, true);
    assert.match(result.text, /credential/);
  });

  it('refuses to clobber an existing id unless told to', async () => {
    await client.callTool('handoff_write', writeArgs(repo, { id: 'dup', overwrite: true }));
    const second = await client.callTool('handoff_write', writeArgs(repo, { id: 'dup' }));
    assert.equal(second.isError, true);
    assert.match(second.text, /already exists/);
  });

  it('reports warnings without refusing the document', async () => {
    const result = await client.callTool(
      'handoff_write',
      writeArgs(repo, {
        id: 'warned',
        overwrite: true,
        targets: ['mobile', 'web'],
        required_actions: '1. Only mobile is mentioned here.',
      }),
    );
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /Worth a look/);
    assert.ok((result.structured?.['warnings'] as unknown[]).length > 0);
  });
});

describe('handoff_list and handoff_read', () => {
  it('lists what was written', async () => {
    const result = await client.callTool('handoff_list', { project_dir: repo });
    assert.equal(result.isError, false);
    assert.match(result.text, /Messages need the write scope/);
  });

  it('reads one back in full', async () => {
    const result = await client.callTool('handoff_read', { project_dir: repo, id: 'facts-check' });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /^---\nhandoff_version: 1/);
  });

  it('says so when the id matches nothing', async () => {
    const result = await client.callTool('handoff_read', { project_dir: repo, id: 'nope' });
    assert.equal(result.isError, true);
    assert.match(result.text, /No handoff with id "nope"/);
  });
});

describe('handoff_receive', () => {
  it('narrows an incoming handoff to this repository target', async () => {
    const consumer = makeRepo();
    dirs.push(consumer);
    const source = readFileSync(
      join(repo, '.handoff', 'facts-check', 'HANDOFF.md'),
      'utf8',
    );

    const result = await client.callTool('handoff_receive', {
      project_dir: consumer,
      markdown: source,
      as: 'mobile',
    });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /# Incoming handoff/);
    assert.ok(result.text.indexOf('## Required Actions') < result.text.indexOf('## Summary'));
    assert.equal(result.structured?.['applies'], true);
    assert.ok(existsSync(join(consumer, '.handoff', 'inbox', 'facts-check', 'HANDOFF.md')));
  });

  it('reports plainly when it does not concern this repository', async () => {
    const consumer = makeRepo();
    dirs.push(consumer);
    const source = readFileSync(join(repo, '.handoff', 'facts-check', 'HANDOFF.md'), 'utf8');
    const result = await client.callTool('handoff_receive', {
      project_dir: consumer,
      markdown: source,
      as: 'devops',
      store: false,
    });
    assert.equal(result.structured?.['applies'], false);
    assert.match(result.text, /does not include "devops"/);
  });

  it('rejects something that is not a handoff', async () => {
    const result = await client.callTool('handoff_receive', {
      project_dir: repo,
      markdown: '# Just notes\n',
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /not a v1 handoff/);
  });
});

describe('handoff_validate and handoff_deliver', () => {
  it('validates a stored handoff', async () => {
    const result = await client.callTool('handoff_validate', {
      project_dir: repo,
      id: 'facts-check',
    });
    assert.equal(result.isError, false, result.text);
  });

  it('fails strict when there are warnings', async () => {
    const result = await client.callTool('handoff_validate', {
      project_dir: repo,
      id: 'warned',
      strict: true,
    });
    assert.equal(result.isError, true);
  });

  it('returns the markdown for the text channel', async () => {
    const result = await client.callTool('handoff_deliver', {
      project_dir: repo,
      id: 'facts-check',
      channel: 'text',
    });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /^---\nhandoff_version: 1/);
  });

  it('writes a copy for the file channel', async () => {
    const target = join(repo, 'out', 'sent.md');
    const result = await client.callTool('handoff_deliver', {
      project_dir: repo,
      id: 'facts-check',
      channel: 'file',
      to: target,
    });
    assert.equal(result.isError, false, result.text);
    assert.ok(existsSync(target));
  });
});

describe('handoff_setup', () => {
  it('writes a config with English as the default language', async () => {
    const fresh = makeRepo();
    dirs.push(fresh);
    const result = await client.callTool('handoff_setup', {
      project_dir: fresh,
      project_name: 'backend',
      targets: ['mobile', 'web'],
    });
    assert.equal(result.isError, false, result.text);
    const config = JSON.parse(readFileSync(join(fresh, 'handoff.config.json'), 'utf8'));
    assert.equal(config.project, 'backend');
    assert.equal(config.language, null);
    assert.deepEqual(config.targets, ['mobile', 'web']);
  });
});

describe('--root confinement', () => {
  it('refuses a project outside the pinned root', async () => {
    const outside = makeRepo();
    dirs.push(outside);
    const pinned = new TestClient(['--root', repo]);
    try {
      await pinned.initialize();
      const result = await pinned.callTool('handoff_context', { project_dir: outside });
      assert.equal(result.isError, true);
      assert.match(result.text, /pinned to/);

      const allowed = await pinned.callTool('handoff_context', { project_dir: repo });
      assert.equal(allowed.isError, false, allowed.text);
    } finally {
      pinned.close();
    }
  });
});

describe('the protocol channel', () => {
  it('never writes anything but JSON-RPC to stdout', async () => {
    // A stray console.log in a tool corrupts the stream for every client.
    const fresh = new TestClient();
    try {
      await fresh.initialize();
      await fresh.callTool('handoff_context', { project_dir: repo });
      await fresh.callTool('handoff_context', { project_dir: '/no/such/dir' });
      const listed = await fresh.request('tools/list');
      assert.ok(Array.isArray((listed as { tools: unknown[] }).tools));
    } finally {
      fresh.close();
    }
  });
});

describe('the methodology is shared, not duplicated', () => {
  it('the MCP prompt carries the same invariants as the skill', async () => {
    const result = (await client.request('prompts/get', {
      name: 'handoff',
      arguments: { target: 'mobile' },
    })) as { messages: Array<{ content: { text: string } }> };
    const prompt = result.messages[0]?.content.text ?? '';

    for (const pattern of [
      /regex matches, not findings/i,
      /only the code says what the behaviour now is/i,
      /most important section/i,
      /no action required/i,
      /building a second implementation/i,
      /\*\*Write in English\.\*\*/,
      /not diff size/i,
      /Never paste a diff/,
    ]) {
      assert.match(prompt, pattern, `MCP prompt lost: ${pattern}`);
    }
  });

  it('the MCP prompt instructs through tools, never through the CLI', async () => {
    const result = (await client.request('prompts/get', {
      name: 'handoff',
      arguments: {},
    })) as { messages: Array<{ content: { text: string } }> };
    const prompt = result.messages[0]?.content.text ?? '';
    assert.match(prompt, /Call `handoff_context`/);
    assert.match(prompt, /Call `handoff_write`/);
    assert.ok(!/handoff context --target/.test(prompt), 'MCP prompt should not drive the CLI');
  });

  it('the receiving prompt keeps the three honest outcomes', async () => {
    const result = (await client.request('prompts/get', {
      name: 'handoff-receive',
      arguments: {},
    })) as { messages: Array<{ content: { text: string } }> };
    const prompt = result.messages[0]?.content.text ?? '';
    assert.match(prompt, /Do not invent work to justify the handoff/);
    assert.match(prompt, /Call `handoff_receive`/);
  });
});

describe('handoff_delivery_options', () => {
  it('answers "where do I send this?" with something specific', async () => {
    const result = await client.callTool('handoff_delivery_options', {
      project_dir: repo,
      targets: ['mobile'],
    });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /No routes configured/);
    assert.match(result.text, /clipboard/);
    assert.ok(Array.isArray(result.structured?.['options']));
  });

  it('names the configured route once a project has one', async () => {
    const routed = makeRepo();
    dirs.push(routed);
    writeFileSync(
      join(routed, 'handoff.config.json'),
      JSON.stringify({
        version: 1,
        project: 'svc',
        channels: { slack: { webhook: '${DEMO_HOOK}', label: '#infra' } },
        routes: { devops: ['slack'] },
      }),
    );
    const result = await client.callTool('handoff_delivery_options', {
      project_dir: routed,
      targets: ['devops'],
    });
    assert.match(result.text, /Configured for devops: #infra/);
    const slack = (result.structured?.['options'] as Array<{ id: string; routed: boolean }>).find(
      (option) => option.id === 'slack',
    );
    assert.equal(slack?.routed, true);
  });

  it('reads the targets off a stored handoff when given an id', async () => {
    await client.callTool('handoff_write', writeArgs(repo, { id: 'routing', overwrite: true }));
    const result = await client.callTool('handoff_delivery_options', {
      project_dir: repo,
      id: 'routing',
    });
    assert.deepEqual(result.structured?.['targets'], ['mobile']);
  });
});

describe('scope_paths', () => {
  it('narrows the change to one slice of a mixed tree', async () => {
    const full = await client.callTool('handoff_context', { project_dir: repo });
    const narrowed = await client.callTool('handoff_context', {
      project_dir: repo,
      scope_paths: ['migration.sql'],
    });
    assert.equal(narrowed.isError, false, narrowed.text);
    assert.match(narrowed.text, /limited to migration\.sql/);

    const fullFiles = (full.structured?.['changed_files'] as unknown[]).length;
    const fewer = (narrowed.structured?.['changed_files'] as unknown[]).length;
    assert.ok(fewer < fullFiles, `${fewer} should be fewer than ${fullFiles}`);
  });

  it('does not collide with handoff_source paths, which mean something else', async () => {
    const result = await client.callTool('handoff_source', {
      project_dir: repo,
      paths: ['routes.js'],
    });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /requirePermission/);
  });
});

describe('the write tool points at delivery', () => {
  it('tells the agent to find a route rather than declaring victory', async () => {
    const result = await client.callTool(
      'handoff_write',
      writeArgs(repo, { id: 'next-step', overwrite: true }),
    );
    assert.match(result.text, /handoff_delivery_options/);
    assert.match(result.text, /Do not deliver without being asked/);
  });
});

describe('symlinks do not widen the boundary', () => {
  // The boundary is path math unless something resolves the link: a file inside the project
  // can point anywhere, and a harmless name can point at a credential.
  const linked = makeRepo();
  const outside = mkdtempSync(join(tmpdir(), 'handoff-outside-'));
  dirs.push(linked, outside);

  it('refuses a file inside the project that links out of it', async () => {
    writeFileSync(join(outside, 'stolen.txt'), 'CONTENTS THAT MUST NOT LEAK\n');
    symlinkSync(join(outside, 'stolen.txt'), join(linked, 'notes.txt'));
    const result = await client.callTool('handoff_source', {
      project_dir: linked,
      paths: ['notes.txt'],
    });
    assert.ok(!result.text.includes('MUST NOT LEAK'), result.text);
    assert.equal(result.isError, true);
    assert.match(result.text, /outside/);
    rmSync(join(linked, 'notes.txt'));
  });

  it('refuses a harmless name that links to a secrets file', async () => {
    writeFileSync(join(linked, '.env'), 'STRIPE_KEY=sk_live_not_real\n');
    symlinkSync(join(linked, '.env'), join(linked, 'notes.md'));
    const result = await client.callTool('handoff_source', {
      project_dir: linked,
      paths: ['notes.md'],
    });
    assert.ok(!result.text.includes('sk_live_not_real'), result.text);
    assert.equal(result.isError, true);
    assert.match(result.text, /secrets file/);
    rmSync(join(linked, 'notes.md'));
    rmSync(join(linked, '.env'));
  });

  it('refuses a secrets file whose name differs only in case', async () => {
    writeFileSync(join(linked, '.ENV'), 'STRIPE_KEY=sk_live_not_real\n');
    const result = await client.callTool('handoff_source', {
      project_dir: linked,
      paths: ['.ENV'],
    });
    assert.equal(result.isError, true, result.text);
    assert.match(result.text, /secrets file/);
    rmSync(join(linked, '.ENV'));
  });

  it('refuses the other files that exist to hold credentials', async () => {
    const paths = ['.npmrc', 'credentials.json', '.aws/credentials', 'keys/id_rsa_work', '.git/config'];
    for (const path of paths) {
      const full = join(linked, path);
      mkdirSync(dirname(full), { recursive: true });
      if (!existsSync(full)) writeFileSync(full, 'token=not-a-real-credential\n');
      const result = await client.callTool('handoff_source', {
        project_dir: linked,
        paths: [path],
      });
      assert.equal(result.isError, true, `${path} was read: ${result.text}`);
      assert.match(result.text, /secrets file/);
    }
  });

  it('refuses a project_dir that links outside the pinned root', async () => {
    const elsewhere = makeRepo();
    dirs.push(elsewhere);
    const bridge = join(linked, 'bridge');
    symlinkSync(elsewhere, bridge);
    const pinned = new TestClient(['--root', linked]);
    try {
      await pinned.initialize();
      const result = await pinned.callTool('handoff_context', { project_dir: bridge });
      assert.equal(result.isError, true, result.text);
      assert.match(result.text, /pinned to/);
    } finally {
      pinned.close();
      rmSync(bridge);
    }
  });
});

describe('an incoming id never chooses where the copy is written', () => {
  it('stores a handoff whose id traverses inside the inbox, and still briefs the reader', async () => {
    const consumer = makeRepo();
    dirs.push(consumer);
    const name = `agents-handoff-pwned-${process.pid}`;
    const escape = `/tmp/${name}`;
    rmSync(escape, { recursive: true, force: true });
    const source = readFileSync(join(repo, '.handoff', 'facts-check', 'HANDOFF.md'), 'utf8').replace(
      /^id: .*$/m,
      `id: ${'../'.repeat(12)}tmp/${name}`,
    );

    const result = await client.callTool('handoff_receive', {
      project_dir: consumer,
      markdown: source,
      as: 'mobile',
    });

    assert.equal(existsSync(escape), false, `wrote outside the project: ${escape}`);
    rmSync(escape, { recursive: true, force: true });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /# Incoming handoff/);
    // Resolved through realpathSync because the boundary now reports canonical paths:
    // on macOS the temp directory reaches the tools as /private/var, not /var.
    const storedAt = result.structured?.['stored_at'];
    assert.equal(typeof storedAt, 'string', JSON.stringify(result.structured));
    assert.ok(
      (storedAt as string).startsWith(join(realpathSync(consumer), '.handoff', 'inbox')),
      storedAt as string,
    );
  });
});

describe('stdout is the protocol, not a delivery channel', () => {
  it('does not advertise stdout as a delivery option', async () => {
    const result = await client.callTool('handoff_delivery_options', { project_dir: repo });
    assert.equal(result.isError, false, result.text);
    const ids = (result.structured?.['options'] as Array<{ id: string }>).map((o) => o.id);
    assert.ok(!ids.includes('stdout'), `stdout must not be offered: ${ids.join(', ')}`);
    assert.ok(!/\bstdout\b/.test(result.text), result.text);
  });

  it('refuses to deliver to stdout, and the connection survives', async () => {
    const fresh = new TestClient();
    try {
      await fresh.initialize();
      const result = await fresh.callTool('handoff_deliver', {
        project_dir: repo,
        id: 'facts-check',
        channel: 'stdout',
      });
      assert.equal(result.isError, true, result.text);
      assert.match(result.text, /text/);
      // The point of the refusal: the stream is still a stream afterwards.
      const after = await fresh.callTool('handoff_read', { project_dir: repo, id: 'facts-check' });
      assert.equal(after.isError, false, after.text);
    } finally {
      fresh.close();
    }
  });
});

describe('what an agent sees when its client shows only structured content', () => {
  // Claude Code shows `structuredContent` to the model whenever a result has one. These
  // read that part on purpose: asserting on the text is how a handoff_read that returned
  // no document went unnoticed — the text was right, and no agent ever saw it.
  const seen = (result: { structured?: Record<string, unknown> | undefined }): string =>
    String(result.structured?.['text'] ?? '');

  it('handoff_read carries the document itself', async () => {
    const result = await client.callTool('handoff_read', { project_dir: repo, id: 'facts-check' });
    assert.equal(result.isError, false, result.text);
    assert.match(seen(result), /^---\nhandoff_version: 1/);
    assert.match(seen(result), /## Required Actions/);
  });

  it('handoff_write carries the next step, not only the id', async () => {
    const result = await client.callTool(
      'handoff_write',
      writeArgs(repo, { id: 'structured-next-step', overwrite: true }),
    );
    assert.equal(result.isError, false, result.text);
    assert.match(seen(result), /handoff_delivery_options/);
  });

  it('handoff_receive carries the whole brief, not only the narrowed actions', async () => {
    const consumer = makeRepo();
    dirs.push(consumer);
    const source = readFileSync(join(repo, '.handoff', 'facts-check', 'HANDOFF.md'), 'utf8');
    const result = await client.callTool('handoff_receive', {
      project_dir: consumer,
      markdown: source,
      as: 'mobile',
      store: false,
    });
    assert.equal(result.isError, false, result.text);
    assert.match(seen(result), /## Verification/);
    assert.match(seen(result), /## Instructions for Receiving Agent/);
  });

  it('handoff_delivery_options carries its guidance line', async () => {
    const result = await client.callTool('handoff_delivery_options', { project_dir: repo, targets: ['mobile'] });
    assert.match(seen(result), /No routes configured|Configured for/);
  });

  it('handoff_context carries its guidance as well as its fields', async () => {
    // The rendered brief has "Suggested reading" and what the brief cannot know; the JSON
    // alone left an agent without either.
    const result = await client.callTool('handoff_context', { project_dir: repo });
    assert.ok(result.structured?.['collectors'], 'the fields are there');
    assert.match(seen(result), /What this brief does not contain/);
  });

  it('an error still says what to do next', async () => {
    const result = await client.callTool(
      'handoff_write',
      writeArgs(repo, { breaking: true, breaking_changes: '', id: 'no-breaking-section', overwrite: true }),
    );
    assert.equal(result.isError, true, result.text);
    assert.ok(result.structured, 'the refusal carries structured errors');
    assert.match(seen(result), /call handoff_write again/);
  });
});

describe('handoff_setup leaves an existing configuration alone', () => {
  it('refuses to replace a config unless told to', async () => {
    const fresh = makeRepo();
    dirs.push(fresh);
    const path = join(fresh, 'handoff.config.json');
    writeFileSync(path, `${JSON.stringify({ version: 1, project: 'kept', routes: { mobile: ['slack'] } }, null, 2)}\n`);

    const refused = await client.callTool('handoff_setup', { project_dir: fresh, project_name: 'replaced' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /already exists/);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).project, 'kept');

    const replaced = await client.callTool('handoff_setup', { project_dir: fresh, project_name: 'replaced', overwrite: true });
    assert.equal(replaced.isError, false, replaced.text);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).project, 'replaced');
  });
});

describe('handoff_deliver holds the same bar as the CLI', () => {
  it('refuses a scaffold that still has TODO markers', async () => {
    const dir = join(repo, '.handoff', 'still-a-template');
    mkdirSync(dir, { recursive: true });
    const finished = readFileSync(join(repo, '.handoff', 'facts-check', 'HANDOFF.md'), 'utf8');
    writeFileSync(
      join(dir, 'HANDOFF.md'),
      finished
        .replace(/^id: .*$/m, 'id: still-a-template')
        .replace(/^status: .*$/m, 'status: draft')
        .replace('## Summary\n', '## Summary\n\n<!-- TODO -->\n'),
    );
    const result = await client.callTool('handoff_deliver', { project_dir: repo, id: 'still-a-template', channel: 'text' });
    assert.equal(result.isError, true);
    assert.match(result.text, /scaffold/);
  });

  it('writes a file only inside the project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'handoff-outside-'));
    dirs.push(outside);
    const result = await client.callTool('handoff_deliver', {
      project_dir: repo,
      id: 'facts-check',
      channel: 'file',
      to: join(outside, 'copy.md'),
    });
    assert.equal(result.isError, true);
    assert.equal(existsSync(join(outside, 'copy.md')), false);
  });

  it('never replaces a file that is not a copy of the same handoff', async () => {
    writeFileSync(join(repo, 'precious.ts'), 'export const keep = true;\n');
    const result = await client.callTool('handoff_deliver', {
      project_dir: repo,
      id: 'facts-check',
      channel: 'file',
      to: 'precious.ts',
    });
    assert.equal(result.isError, true);
    assert.equal(readFileSync(join(repo, 'precious.ts'), 'utf8'), 'export const keep = true;\n');
  });
});

describe('handoff_receive and files that were sent to you', () => {
  it('says how to hand over a file from outside the project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'handoff-downloads-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'incoming.md'), readFileSync(join(repo, '.handoff', 'facts-check', 'HANDOFF.md'), 'utf8'));
    const result = await client.callTool('handoff_receive', { project_dir: repo, file_path: join(outside, 'incoming.md') });
    assert.equal(result.isError, true);
    assert.match(result.text, /markdown/);
  });
});

describe('handoff_delivery_options reports configuration mistakes', () => {
  it('names a route to a channel that does not exist, and a webhook written into the file', async () => {
    const fresh = makeRepo();
    dirs.push(fresh);
    writeFileSync(
      join(fresh, 'handoff.config.json'),
      `${JSON.stringify({
        version: 1,
        project: 'svc',
        channels: { slack: { webhook: 'https://hooks.slack.com/services/T000/B000/abcdefgh' } },
        routes: { mobile: ['slak'] },
      }, null, 2)}\n`,
    );
    const result = await client.callTool('handoff_delivery_options', { project_dir: fresh, targets: ['mobile'] });
    const problems = (result.structured?.['config_problems'] ?? []) as string[];
    assert.ok(problems.some((problem) => /"slak", which is not a channel/.test(problem)));
    assert.ok(problems.some((problem) => /channels\.slack\.webhook is written into/.test(problem)));
  });
});

describe('an id is an id, never a path', () => {
  it('does not read a file named by an id-shaped path', async () => {
    writeFileSync(join(repo, '.env'), 'DB_PASSWORD=hunter2-prod-9f8e\n');
    for (const tool of ['handoff_read', 'handoff_validate'] as const) {
      for (const id of [join(repo, '.env'), '../../../../etc/hosts', '.env']) {
        const result = await client.callTool(tool, { project_dir: repo, id });
        assert.equal(result.isError, true, `${tool} ${id}: ${result.text}`);
        assert.doesNotMatch(result.text, /hunter2/);
      }
    }
  });

  it('says which handoffs an ambiguous part of an id matched', async () => {
    await client.callTool('handoff_write', writeArgs(repo, { id: 'ambiguous-one', overwrite: true }));
    await client.callTool('handoff_write', writeArgs(repo, { id: 'ambiguous-two', overwrite: true }));
    const result = await client.callTool('handoff_read', { project_dir: repo, id: 'ambiguous' });
    assert.equal(result.isError, true);
    assert.match(result.text, /ambiguous-one/);
    assert.match(result.text, /ambiguous-two/);
  });
});

describe('handoff_source diff mode takes paths literally', () => {
  it('does not expand a glob into a secrets file, and withholds one inside a directory', async () => {
    const fresh = makeRepo();
    dirs.push(fresh);
    mkdirSync(join(fresh, 'config'), { recursive: true });
    writeFileSync(join(fresh, '.env'), 'DB_PASSWORD=hunter2-prod-9f8e\n');
    writeFileSync(join(fresh, 'config', '.env'), 'API_TOKEN=q8Zr2LmX9vTe4Kd1\n');
    writeFileSync(join(fresh, 'config', 'app.json'), '{ "port": 8080 }\n');
    for (const paths of [['.en?'], ['*'], ['config']]) {
      const result = await client.callTool('handoff_source', { project_dir: fresh, paths, mode: 'diff', working: true });
      assert.doesNotMatch(result.text, /hunter2|q8Zr2LmX/, `${paths.join(',')}: ${result.text}`);
    }
    const directory = await client.callTool('handoff_source', { project_dir: fresh, paths: ['config'], mode: 'diff', working: true });
    assert.match(directory.text, /app\.json/);
    assert.match(directory.text, /Withheld 1 file/);
  });

  it('withholds a file whose contents are a private key, whatever it is called', async () => {
    const fresh = makeRepo();
    dirs.push(fresh);
    writeFileSync(join(fresh, 'notes.txt'), '-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----\n');
    const result = await client.callTool('handoff_source', { project_dir: fresh, paths: ['notes.txt'] });
    assert.doesNotMatch(result.text, /MIGT/);
    assert.match(result.text, /withheld/);
  });

  it('refuses the credential files people actually keep in repositories', async () => {
    const fresh = makeRepo();
    dirs.push(fresh);
    for (const name of ['.envrc', '.dev.vars', 'AuthKey_ABC123DEFG.p8', 'app-firebase-adminsdk-x1y2z.json', 'prod.tfvars']) {
      writeFileSync(join(fresh, name), 'secret\n');
      const result = await client.callTool('handoff_source', { project_dir: fresh, paths: [name] });
      assert.equal(result.isError, true, `${name}: ${result.text}`);
    }
  });
});

describe('the pinned root holds for writes, too', () => {
  it('writes setup inside the pinned tree when the git root is outside it', async () => {
    const mono = makeRepo();
    dirs.push(mono);
    const pkg = join(mono, 'packages', 'app');
    mkdirSync(pkg, { recursive: true });
    const pinned = new TestClient(['--root', pkg]);
    try {
      await pinned.initialize();
      const result = await pinned.callTool('handoff_setup', { project_dir: pkg, project_name: 'app' });
      assert.equal(result.isError, false, result.text);
      assert.ok(existsSync(join(pkg, 'handoff.config.json')));
      assert.ok(!existsSync(join(mono, 'handoff.config.json')), 'wrote outside the pinned root');
    } finally {
      pinned.close();
    }
  });

  it('refuses to store handoffs outside the pinned tree when the config points there', async () => {
    const mono = makeRepo();
    dirs.push(mono);
    const pkg = join(mono, 'packages', 'app');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(mono, 'handoff.config.json'), `${JSON.stringify({ version: 1, project: 'mono' })}\n`);
    const pinned = new TestClient(['--root', pkg]);
    try {
      await pinned.initialize();
      const result = await pinned.callTool('handoff_write', writeArgs(pkg, { id: 'outside-pin' }));
      assert.equal(result.isError, true);
      assert.match(result.text, /outside the pinned root/);
      assert.ok(!existsSync(join(mono, '.handoff', 'outside-pin')));
    } finally {
      pinned.close();
    }
  });
});

describe('handoff_deliver follows every route, and never stdout', () => {
  it('delivers to each routed channel, refuses a stdout route, and the connection survives', async () => {
    const fresh = makeRepo();
    dirs.push(fresh);
    writeFileSync(
      join(fresh, 'handoff.config.json'),
      `${JSON.stringify({ version: 1, project: 'svc', routes: { mobile: ['file'], web: ['stdout'] } })}\n`,
    );
    const written = await client.callTool('handoff_write', writeArgs(fresh, { id: 'two-teams', targets: ['mobile', 'web'] }));
    assert.equal(written.isError, false, written.text);

    const result = await client.callTool('handoff_deliver', { project_dir: fresh, id: 'two-teams', open: false });
    const deliveries = (result.structured?.['deliveries'] ?? []) as Array<{ channel: string; ok: boolean }>;
    assert.deepEqual(deliveries.map((entry) => entry.channel).sort(), ['file', 'stdout']);
    assert.equal(deliveries.find((entry) => entry.channel === 'stdout')?.ok, false);
    assert.equal(deliveries.find((entry) => entry.channel === 'file')?.ok, true);

    // The server is still speaking JSON-RPC.
    const after = await client.callTool('handoff_list', { project_dir: fresh });
    assert.equal(after.isError, false);
  });

  it('puts a file delivery with no destination in an outbox directory, every time', async () => {
    const fresh = makeRepo();
    dirs.push(fresh);
    await client.callTool('handoff_write', writeArgs(fresh, { id: 'first-out' }));
    await client.callTool('handoff_write', writeArgs(fresh, { id: 'second-out' }));
    for (const id of ['first-out', 'second-out']) {
      const result = await client.callTool('handoff_deliver', { project_dir: fresh, id, channel: 'file' });
      assert.equal(result.isError, false, result.text);
      assert.ok(existsSync(join(fresh, '.handoff', 'outbox', `${id}.md`)));
    }
  });

  it('does not write through a dangling symlink to outside the project', async () => {
    const fresh = makeRepo();
    dirs.push(fresh);
    const outside = mkdtempSync(join(tmpdir(), 'handoff-dangling-'));
    dirs.push(outside);
    symlinkSync(join(outside, 'planted.md'), join(fresh, 'copy.md'));
    await client.callTool('handoff_write', writeArgs(fresh, { id: 'dangling' }));
    const result = await client.callTool('handoff_deliver', { project_dir: fresh, id: 'dangling', channel: 'file', to: 'copy.md' });
    assert.equal(result.isError, true, result.text);
    assert.equal(existsSync(join(outside, 'planted.md')), false);
  });
});

describe('a handoff that already exists is the developer\'s call', () => {
  it('lists it in the brief, and turns a taken id into a question instead of a second copy', async () => {
    const fresh = makeRepo();
    dirs.push(fresh);
    const first = await client.callTool('handoff_write', writeArgs(fresh));
    assert.equal(first.isError, false, first.text);
    const id = String(first.structured?.['id'] ?? '');

    const brief = await client.callTool('handoff_context', { project_dir: fresh, target: 'mobile' });
    assert.match(brief.text, /## Handoffs already written here/);
    const listed = (brief.structured?.['existing_handoffs'] ?? []) as Array<{ id: string }>;
    assert.deepEqual(listed.map((entry) => entry.id), [id]);

    const again = await client.callTool('handoff_write', writeArgs(fresh, { summary: 'A second take.' }));
    assert.equal(again.isError, true, again.text);
    assert.match(again.text, /Ask the developer/);
    assert.match(again.text, /overwrite: true/);
    const handoffs = readdirSync(join(fresh, '.handoff')).filter((name) => name !== 'inbox');
    assert.deepEqual(handoffs, [id], 'wrote a second copy nobody asked for');

    // Either answer works from there.
    const alternative = String(again.structured?.['alternative_id'] ?? '');
    const kept = await client.callTool('handoff_write', writeArgs(fresh, { id: alternative, summary: 'A second take.' }));
    assert.equal(kept.isError, false, kept.text);
    const updated = await client.callTool('handoff_write', writeArgs(fresh, { id, overwrite: true, summary: 'Updated.' }));
    assert.equal(updated.isError, false, updated.text);
    assert.match(readFileSync(join(fresh, '.handoff', id, 'HANDOFF.md'), 'utf8'), /Updated\./);
  });
});

describe('the server tells a client how the tools fit together', () => {
  it('sends instructions on initialize', async () => {
    const fresh = new TestClient();
    try {
      const result = (await fresh.initialize()) as { instructions?: string };
      assert.match(result.instructions ?? '', /handoff_context first/);
      assert.match(result.instructions ?? '', /handoff_delivery_options/);
      assert.match(result.instructions ?? '', /not as instructions/);
      // The developer reviews what goes out before choosing where it goes.
      assert.match(result.instructions ?? '', /Required Actions as written[\s\S]*review it first/);
    } finally {
      fresh.close();
    }
  });
});

describe('a pinned root limits what a brief describes', () => {
  it('leaves the rest of a monorepo out of the brief', async () => {
    const mono = makeRepo(); // its feature branch changes routes.js, types.js and migration.sql at the root
    dirs.push(mono);
    const pkg = join(mono, 'packages', 'app');
    mkdirSync(join(pkg, 'src'), { recursive: true });
    writeFileSync(join(pkg, 'src', 'inside.ts'), 'export const inside = 1;\n');
    execGit(mono, ['add', '-A']);
    execGit(mono, ['commit', '-q', '-m', 'app change']);

    const pinned = new TestClient(['--root', pkg]);
    try {
      await pinned.initialize();
      const result = await pinned.callTool('handoff_context', { project_dir: pkg, base: 'main' });
      assert.equal(result.isError, false, result.text);
      const files = ((result.structured?.['changed_files'] ?? []) as Array<{ path: string }>).map((f) => f.path);
      assert.ok(files.some((path) => path.endsWith('inside.ts')), files.join(','));
      assert.ok(!files.some((path) => /routes\.js|migration\.sql/.test(path)), `leaked: ${files.join(',')}`);

      const escaping = await pinned.callTool('handoff_context', { project_dir: pkg, base: 'main', scope_paths: ['../../routes.js'] });
      assert.equal(escaping.isError, true);
    } finally {
      pinned.close();
    }
  });
});

function execGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('the Codex skills', () => {
  it('have frontmatter Codex accepts, and leave model invocation on', async () => {
    const { parse } = await import('yaml');
    const { skillFiles } = await import('../src/prompts.ts');
    const skills = skillFiles();
    assert.deepEqual(skills.map((skill) => skill.name), ['handoff', 'handoff-receive']);
    for (const skill of skills) {
      const block = /^---\n([\s\S]*?)\n---\n/.exec(skill.contents)?.[1] ?? '';
      const meta = parse(block) as Record<string, unknown>;
      assert.equal(meta['name'], skill.name);
      assert.ok(String(meta['description']).length > 40);
      // Codex rejects a plugin whose skill sets it to anything but false.
      assert.ok(meta['disable-model-invocation'] === undefined || meta['disable-model-invocation'] === false);
      assert.match(skill.contents, /handoff_(context|receive)/);
    }
    // Codex has a question tool that returns before the answer; telling it there is none
    // made it ask twice, once in a dialog and once in text.
    const writing = skills.find((skill) => skill.name === 'handoff')?.contents ?? '';
    assert.doesNotMatch(writing, /There is no tool for this/);
    assert.match(writing, /returns before the developer has answered, stop there/);
    assert.match(writing, /let me review it first/);
  });
});

describe('a credential in a handoff someone else wrote', () => {
  const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const leaky = (): string =>
    readFileSync(join(repo, '.handoff', 'facts-check', 'HANDOFF.md'), 'utf8').replace(
      '## Verification',
      `## Notes\n\nUse token ${TOKEN} to test.\n\n## Verification`,
    );

  it('fails handoff_validate, naming the line without repeating the secret', async () => {
    const result = await client.callTool('handoff_validate', { project_dir: repo, markdown: leaky() });
    assert.equal(result.isError, true, result.text);
    assert.match(result.text, /Credentials:/);
    assert.equal(result.structured?.['ok'], false);
    assert.ok(((result.structured?.['secrets'] ?? []) as unknown[]).length > 0);
    assert.ok(!JSON.stringify(result.structured).includes(TOKEN), 'the secret came back unmasked');
  });

  it('is read by handoff_receive but not stored', async () => {
    const consumer = makeRepo();
    dirs.push(consumer);
    const result = await client.callTool('handoff_receive', { project_dir: consumer, markdown: leaky(), as: 'mobile' });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /# Incoming handoff/);
    assert.match(result.text, /Not stored: this looks like it contains a credential/);
    assert.equal(result.structured?.['stored_at'], null);
    assert.equal(existsSync(join(consumer, '.handoff', 'inbox')), false);
  });
});

describe('the server binary from a terminal', () => {
  it('answers --version and --help instead of waiting for a client', () => {
    const { version } = JSON.parse(readFileSync(join(dirname(SERVER_BIN), '..', '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    const run = (flag: string): string =>
      execFileSync(process.execPath, [SERVER_BIN, flag], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(run('--version').trim(), version);
    assert.match(run('--help'), /--root/);
  });
});
