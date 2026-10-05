import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitFrontmatter, stringifyFrontmatterYaml } from '../src/markdown/frontmatter.ts';
import { HandoffParseError, parseHandoff } from '../src/markdown/parse.ts';
import { extractCodeBlocks, findSection, hasContent, parseBody } from '../src/markdown/sections.ts';
import { serializeHandoff } from '../src/markdown/serialize.ts';
import { VALID_HANDOFF } from './helpers.ts';

describe('splitFrontmatter', () => {
  it('splits a fenced frontmatter block from the body', () => {
    const result = splitFrontmatter('---\na: 1\n---\n\n# Title\n');
    assert.equal(result.yaml, 'a: 1');
    assert.equal(result.body.trim(), '# Title');
  });

  it('treats a document with no leading fence as all body', () => {
    const result = splitFrontmatter('# Title\n\n---\n\nnot frontmatter\n');
    assert.equal(result.yaml, null);
  });

  it('does not treat a horizontal rule further down as a closing fence', () => {
    const result = splitFrontmatter('# Title\n\ntext\n\n---\n\nmore\n');
    assert.equal(result.yaml, null);
    assert.match(result.body, /more/);
  });

  it('returns no frontmatter when the opening fence is never closed', () => {
    assert.equal(splitFrontmatter('---\na: 1\n\n# Title\n').yaml, null);
  });

  it('tolerates a byte order mark and CRLF line endings', () => {
    const result = splitFrontmatter('\uFEFF---\r\nid: x\r\n---\r\n\r\n# Title\r\n');
    assert.equal(result.yaml, 'id: x');
    assert.equal(result.body.includes('\r'), false);
  });
});

describe('parseBody', () => {
  it('extracts the title, preamble and sections in order', () => {
    const body = parseBody('# Title\n\nintro\n\n## One\n\na\n\n## Two\n\nb\n');
    assert.equal(body.title, 'Title');
    assert.equal(body.h1Count, 1);
    assert.equal(body.preamble, 'intro');
    assert.deepEqual(
      body.sections.map((section) => section.title),
      ['One', 'Two'],
    );
    assert.equal(body.sections[1]?.content, 'b');
  });

  it('ignores headings inside fenced code blocks', () => {
    const body = parseBody('# Title\n\n## Real\n\n```sh\n## not a heading\n# also not\n```\n');
    assert.deepEqual(
      body.sections.map((section) => section.title),
      ['Real'],
    );
    assert.equal(body.h1Count, 1);
  });

  it('counts multiple H1s so the validator can reject them', () => {
    assert.equal(parseBody('# One\n\n# Two\n').h1Count, 2);
  });

  it('handles tilde fences and nested backticks', () => {
    const body = parseBody('# T\n\n## S\n\n~~~\n## inside\n~~~\n\n## After\n\nx\n');
    assert.deepEqual(
      body.sections.map((section) => section.title),
      ['S', 'After'],
    );
  });
});

describe('findSection / hasContent', () => {
  const sections = [
    { title: 'Required Actions', content: '1. do it' },
    { title: 'Notes', content: '   ' },
  ];

  it('matches case- and whitespace-insensitively', () => {
    assert.ok(findSection(sections, 'required actions'));
    assert.ok(findSection(sections, '  REQUIRED   ACTIONS '));
  });

  it('treats a whitespace-only section as empty', () => {
    assert.equal(hasContent(sections, 'Notes'), false);
    assert.equal(hasContent(sections, 'Required Actions'), true);
  });
});

describe('extractCodeBlocks', () => {
  it('reports language and line count', () => {
    const blocks = extractCodeBlocks('text\n\n```json\n{\n  "a": 1\n}\n```\n');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.language, 'json');
    assert.equal(blocks[0]?.lineCount, 3);
  });
});

describe('parseHandoff', () => {
  it('parses frontmatter and body', () => {
    const handoff = parseHandoff(VALID_HANDOFF);
    assert.equal(handoff.frontmatter.id, '2026-08-28-rate-limit');
    assert.equal(handoff.frontmatter.breaking, false);
    assert.deepEqual(handoff.frontmatter.targets, ['web']);
    assert.equal(handoff.title, 'Rate limiting on /search');
    assert.ok(findSection(handoff.sections, 'Required Actions'));
  });

  it('throws when there is no frontmatter at all', () => {
    assert.throws(() => parseHandoff('# Just markdown\n'), HandoffParseError);
  });

  it('throws on malformed YAML rather than guessing', () => {
    assert.throws(() => parseHandoff('---\n a: [1,\n---\n\n# T\n'), HandoffParseError);
  });

  it('accepts a scalar shorthand for targets', () => {
    const handoff = parseHandoff('---\nhandoff_version: 1\ntargets: mobile\n---\n\n# T\n');
    assert.deepEqual(handoff.frontmatter.targets, ['mobile']);
  });

  it('keeps an unquoted timestamp verbatim', () => {
    // YAML 1.2 has no timestamp type, so this arrives as a plain string and must survive
    // untouched — rewriting it would make round-tripping lossy for no benefit.
    const handoff = parseHandoff('---\nhandoff_version: 1\ncreated_at: 2026-08-28T18:20:00Z\n---\n\n# T\n');
    assert.equal(handoff.frontmatter.created_at, '2026-08-28T18:20:00Z');
  });

  it('keeps `breaking` as written when it is not a boolean, instead of reading it as false', () => {
    // YAML 1.2 parses `yes` as the string "yes". Coercing it to `false` would answer the
    // one question the protocol exists to carry, on the writer's behalf, wrongly.
    const handoff = parseHandoff('---\nhandoff_version: 1\nbreaking: yes\n---\n\n# T\n');
    assert.equal(handoff.frontmatter.declared?.['breaking'], 'yes');
  });

  it('records which coerced keys the document actually wrote', () => {
    const written = parseHandoff('---\nhandoff_version: 1\nbreaking: false\ntargets: []\n---\n\n# T\n');
    assert.equal(Object.hasOwn(written.frontmatter.declared ?? {}, 'breaking'), true);
    assert.equal(Object.hasOwn(written.frontmatter.declared ?? {}, 'targets'), true);
    assert.equal(Object.hasOwn(written.frontmatter.declared ?? {}, 'change_type'), false);
  });

  it('preserves unknown keys nested under source', () => {
    const handoff = parseHandoff(
      '---\nhandoff_version: 1\nsource:\n  project: backend\n  x-service: payments\n---\n\n# T\n',
    );
    assert.deepEqual(handoff.frontmatter.source.extra, { 'x-service': 'payments' });
  });

  it('preserves unknown frontmatter keys under extra', () => {
    const handoff = parseHandoff('---\nhandoff_version: 1\nx-team: payments\nmystery: 4\n---\n\n# T\n');
    assert.deepEqual(handoff.frontmatter.extra, { 'x-team': 'payments', mystery: 4 });
  });

  it('does not invent a title when the body has no H1', () => {
    assert.equal(parseHandoff('---\nhandoff_version: 1\n---\n\ntext\n').title, '');
  });
});

describe('serializeHandoff', () => {
  it('round-trips a document without losing information', () => {
    const first = parseHandoff(VALID_HANDOFF);
    const second = parseHandoff(serializeHandoff(first));

    assert.deepEqual(second.frontmatter, { ...first.frontmatter });
    assert.equal(second.title, first.title);
    assert.deepEqual(second.sections, first.sections);
  });

  it('is idempotent: serializing twice produces identical text', () => {
    const once = serializeHandoff(parseHandoff(VALID_HANDOFF));
    const twice = serializeHandoff(parseHandoff(once));
    assert.equal(once, twice);
  });

  it('writes frontmatter keys in canonical order', () => {
    const text = serializeHandoff(parseHandoff(VALID_HANDOFF));
    const keys = (text.split('---')[1] ?? '')
      .split('\n')
      .filter((line) => /^\w/.test(line))
      .map((line) => line.split(':')[0]);
    assert.deepEqual(keys, [
      'handoff_version',
      'id',
      'title',
      'created_at',
      'status',
      'breaking',
      'source',
      'targets',
      'change_type',
    ]);
  });

  it('preserves unknown keys through a round trip', () => {
    const source = VALID_HANDOFF.replace('handoff_version: 1', 'handoff_version: 1\nx-team: payments');
    const text = serializeHandoff(parseHandoff(source));
    assert.match(text, /x-team: payments/);
  });

  it('round-trips a document with x- keys and a body H1 of its own, byte for byte', () => {
    // Everything here has been dropped or rewritten by a serializer at some point: the
    // `x-` key nested under `source`, and a body `#` heading that says something other
    // than the frontmatter `title`.
    const source = `---
handoff_version: 1
id: 2026-08-28-x-keys
title: Refresh tokens are single-use
created_at: 2026-08-28T18:20:00Z
status: ready
breaking: true
source:
  project: backend
  x-service: payments
targets:
  - web
change_type:
  - api
x-team: payments
---

# Read this before your next release

## Summary

Refresh now rotates the token.
`;
    assert.equal(serializeHandoff(parseHandoff(source)), source);
  });

  it('writes an unreadable `breaking` back as it was written rather than as false', () => {
    const source = VALID_HANDOFF.replace('breaking: false', 'breaking: yes');
    assert.match(serializeHandoff(parseHandoff(source)), /^breaking: yes$/m);
  });

  it('does not invent a required key the document never wrote', () => {
    const source = VALID_HANDOFF.replace('breaking: false\n', '');
    const text = serializeHandoff(parseHandoff(source));
    assert.equal(/^breaking:/m.test(text), false);
  });

  it('preserves non-standard sections', () => {
    const source = `${VALID_HANDOFF}\n## Rollout\n\nMonday.\n`;
    const handoff = parseHandoff(serializeHandoff(parseHandoff(source)));
    assert.equal(findSection(handoff.sections, 'Rollout')?.content, 'Monday.');
  });
});

describe('stringifyFrontmatterYaml', () => {
  it('does not wrap long values', () => {
    const yaml = stringifyFrontmatterYaml({ note: 'x'.repeat(200) });
    assert.equal(yaml.split('\n').length, 1);
  });
});
