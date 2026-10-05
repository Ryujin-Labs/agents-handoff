import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseHandoff } from '../src/markdown/parse.ts';
import { isIsoTimestamp, validateHandoff, validateHandoffSource } from '../src/schema/validate.ts';
import type { Issue } from '../src/types.ts';
import { VALID_HANDOFF } from './helpers.ts';

function codes(issues: Issue[]): string[] {
  return issues.map((issue) => issue.code);
}

describe('validateHandoffSource', () => {
  it('accepts a conforming document with no errors', () => {
    const result = validateHandoffSource(VALID_HANDOFF);
    assert.equal(result.ok, true, codes(result.errors).join(', '));
    assert.deepEqual(result.errors, []);
  });

  it('reports a parse failure as an error rather than throwing', () => {
    const result = validateHandoffSource('# no frontmatter\n');
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result.errors), ['parse-failed']);
  });
});

describe('required frontmatter', () => {
  const check = (mutate: (source: string) => string): Issue[] =>
    validateHandoffSource(mutate(VALID_HANDOFF)).errors;

  it('rejects a missing handoff_version', () => {
    assert.ok(codes(check((s) => s.replace('handoff_version: 1\n', ''))).includes('missing-version'));
  });

  it('rejects a future version it cannot speak', () => {
    assert.ok(
      codes(check((s) => s.replace('handoff_version: 1', 'handoff_version: 2'))).includes(
        'unsupported-version',
      ),
    );
  });

  it('rejects an id with spaces or uppercase', () => {
    assert.ok(codes(check((s) => s.replace(/^id: .*$/m, 'id: Not An Id'))).includes('invalid-id'));
  });

  it('rejects a non-ISO created_at', () => {
    assert.ok(
      codes(check((s) => s.replace(/^created_at: .*$/m, 'created_at: yesterday'))).includes(
        'invalid-created-at',
      ),
    );
  });

  it('rejects a timestamp with no timezone offset', () => {
    assert.ok(
      codes(check((s) => s.replace(/^created_at: .*$/m, 'created_at: 2026-08-28T18:20:00'))).includes(
        'invalid-created-at',
      ),
    );
  });

  it('rejects an unknown status', () => {
    assert.ok(codes(check((s) => s.replace('status: ready', 'status: shipped'))).includes('invalid-status'));
  });

  it('rejects a missing source.project', () => {
    assert.ok(
      codes(check((s) => s.replace('  project: backend\n', ''))).includes('missing-source-project'),
    );
  });

  it('rejects a missing breaking', () => {
    assert.ok(codes(check((s) => s.replace('breaking: false\n', ''))).includes('missing-breaking'));
  });

  it('rejects a missing targets', () => {
    assert.ok(codes(check((s) => s.replace('targets:\n  - web\n', ''))).includes('missing-targets'));
  });

  it('rejects a missing change_type', () => {
    assert.ok(
      codes(check((s) => s.replace('change_type:\n  - api\n', ''))).includes('missing-change-type'),
    );
  });

  it('still accepts the empty lists the spec allows, with only a warning', () => {
    const source = VALID_HANDOFF.replace('targets:\n  - web', 'targets: []').replace(
      'change_type:\n  - api',
      'change_type: []',
    );
    const result = validateHandoffSource(source);
    assert.equal(result.ok, true, codes(result.errors).join(', '));
    assert.ok(codes(result.warnings).includes('no-targets'));
  });
});

// `breaking: yes` is muscle memory from Ansible and YAML 1.1, and under YAML 1.2 it is the
// string "yes". Read as `false` it silently un-marks the change, drops the requirement for
// a "Breaking Changes" section, and takes the warning off the receiver's brief — so it is
// rejected rather than guessed at, even though rejecting costs the reader the document.
describe('breaking is not guessed at', () => {
  const check = (value: string): Issue[] =>
    validateHandoffSource(VALID_HANDOFF.replace('breaking: false', `breaking: ${value}`)).errors;

  for (const value of ['yes', 'no', '"true"', "'false'", '1', '0', 'maybe']) {
    it(`rejects breaking: ${value}`, () => {
      assert.ok(codes(check(value)).includes('invalid-breaking'), `accepted breaking: ${value}`);
    });
  }

  it('rejects a valueless breaking:', () => {
    assert.ok(codes(check('')).includes('invalid-breaking'));
  });

  it('accepts the two values that are decisions', () => {
    assert.equal(codes(check('true')).includes('invalid-breaking'), false);
    assert.equal(codes(check('false')).includes('invalid-breaking'), false);
  });

  it('does not let a mis-typed breaking pass as a non-breaking change', () => {
    // The whole consequence chain: `yes` used to validate clean, which meant the document
    // needed no "Breaking Changes" section and the receiver was never warned.
    const source = VALID_HANDOFF.replace('breaking: false', 'breaking: yes');
    assert.equal(validateHandoffSource(source).ok, false);
  });

  it('rejects a targets or change_type that is not a list of labels', () => {
    const source = VALID_HANDOFF.replace('targets:\n  - web', 'targets:\n  web: yes');
    assert.ok(codes(validateHandoffSource(source).errors).includes('invalid-targets'));
  });
});

describe('required sections', () => {
  it('rejects a document missing Required Actions', () => {
    const source = VALID_HANDOFF.replace(/## Required Actions[\s\S]*?(?=## Verification)/, '');
    const result = validateHandoffSource(source);
    assert.equal(result.ok, false);
    const issue = result.errors.find((entry) => entry.code === 'missing-section');
    assert.equal(issue?.path, 'Required Actions');
  });

  it('rejects a section that exists but is empty', () => {
    const source = VALID_HANDOFF.replace(
      /## Summary\n\n.*\n/,
      '## Summary\n\n\n',
    );
    assert.ok(codes(validateHandoffSource(source).errors).includes('missing-section'));
  });

  it('rejects a body with no H1', () => {
    const source = VALID_HANDOFF.replace('# Rate limiting on /search\n\n', '');
    assert.ok(codes(validateHandoffSource(source).errors).includes('missing-title'));
  });
});

describe('breaking-change coupling', () => {
  it('requires Breaking Changes when breaking is true', () => {
    const source = VALID_HANDOFF.replace('breaking: false', 'breaking: true');
    const result = validateHandoffSource(source);
    assert.equal(result.ok, false);
    const issue = result.errors.find((entry) => entry.path === 'Breaking Changes');
    assert.match(issue?.message ?? '', /required because/);
  });

  it('accepts breaking: true with the section present', () => {
    const source = VALID_HANDOFF.replace('breaking: false', 'breaking: true').replace(
      '## Verification',
      '## Breaking Changes\n\nClients that ignore this stop working.\n\n## Verification',
    );
    assert.equal(validateHandoffSource(source).ok, true);
  });

  it('warns when the section is present but breaking is false', () => {
    const source = VALID_HANDOFF.replace(
      '## Verification',
      '## Breaking Changes\n\nSomething breaks.\n\n## Verification',
    );
    assert.ok(codes(validateHandoffSource(source).warnings).includes('breaking-mismatch'));
  });

  it('does not warn about that mismatch on a draft, which is expected to be undecided', () => {
    const source = VALID_HANDOFF.replace('status: ready', 'status: draft').replace(
      '## Verification',
      '## Breaking Changes\n\nCandidate to confirm.\n\n## Verification',
    );
    assert.ok(!codes(validateHandoffSource(source).warnings).includes('breaking-mismatch'));
  });
});

describe('quality warnings', () => {
  it('rejects a document marked ready that still contains scaffold TODO markers', () => {
    // SPEC.md 2.5: a ready document claims to be finished. Delivering one that is not is
    // how a teammate receives a template instead of a handoff.
    const source = VALID_HANDOFF.replace(
      '1. Handle 429 distinctly from 5xx.',
      '1. <!-- TODO --> decide this',
    );
    const result = validateHandoffSource(source);
    assert.equal(result.ok, false);
    assert.ok(codes(result.errors).includes('unfilled-template'));
  });

  it('only warns about TODO markers in a draft, which is allowed to be unfinished', () => {
    const source = VALID_HANDOFF.replace('status: ready', 'status: draft').replace(
      '1. Handle 429 distinctly from 5xx.',
      '1. <!-- TODO --> decide this',
    );
    const result = validateHandoffSource(source);
    assert.equal(result.ok, true);
    assert.ok(codes(result.warnings).includes('unfilled-template'));
  });

  it('flags a pasted diff', () => {
    const source = VALID_HANDOFF.replace(
      '## Verification',
      '## Notes\n\n```\ndiff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n```\n\n## Verification',
    );
    assert.ok(codes(validateHandoffSource(source).warnings).includes('diff-dump'));
  });

  it('flags an oversized code block', () => {
    const block = ['```', ...Array.from({ length: 70 }, (_, i) => `line ${i}`), '```'].join('\n');
    const source = VALID_HANDOFF.replace('## Verification', `## Notes\n\n${block}\n\n## Verification`);
    assert.ok(codes(validateHandoffSource(source).warnings).includes('oversized-code-block'));
  });

  it('flags a Required Actions section with no list items', () => {
    const source = VALID_HANDOFF.replace(
      '1. Handle 429 distinctly from 5xx.\n2. Respect `Retry-After`.',
      'Just be careful about rate limits.',
    );
    assert.ok(codes(validateHandoffSource(source).warnings).includes('unstructured-actions'));
  });

  it('flags a target that Required Actions never mentions', () => {
    const source = VALID_HANDOFF.replace('  - web\n', '  - web\n  - mobile\n');
    assert.ok(codes(validateHandoffSource(source).warnings).includes('target-not-addressed'));
  });

  it('does not flag a single target that is never named, since all actions are theirs', () => {
    assert.ok(!codes(validateHandoffSource(VALID_HANDOFF).warnings).includes('target-not-addressed'));
  });

  it('warns about a change_type outside the known vocabulary without rejecting it', () => {
    const source = VALID_HANDOFF.replace('  - api', '  - api\n  - telepathy');
    const result = validateHandoffSource(source);
    assert.equal(result.ok, true);
    assert.ok(codes(result.warnings).includes('unknown-change-type'));
  });

  it('warns about an unknown frontmatter key but not about an x- extension', () => {
    const known = validateHandoffSource(VALID_HANDOFF.replace('handoff_version: 1', 'handoff_version: 1\nx-team: pay'));
    assert.ok(!codes(known.warnings).includes('unknown-field'));

    const unknown = validateHandoffSource(VALID_HANDOFF.replace('handoff_version: 1', 'handoff_version: 1\nteam: pay'));
    assert.ok(codes(unknown.warnings).includes('unknown-field'));
  });

  it('warns about a non-standard section without rejecting it', () => {
    const source = `${VALID_HANDOFF}\n## Rollout\n\nMonday.\n`;
    const result = validateHandoffSource(source);
    assert.equal(result.ok, true);
    assert.ok(codes(result.warnings).includes('unknown-section'));
  });

  it('warns when a handoff has grown past the length limit', () => {
    const filler = `\n\n${'word '.repeat(1400)}`;
    const result = validateHandoffSource(VALID_HANDOFF + filler);
    assert.ok(codes(result.warnings).includes('too-long'));
  });
});

describe('validateHandoff on a parsed document', () => {
  it('produces the same verdict as validating the source', () => {
    const handoff = parseHandoff(VALID_HANDOFF);
    assert.equal(validateHandoff(handoff).ok, validateHandoffSource(VALID_HANDOFF).ok);
  });
});

describe('isIsoTimestamp', () => {
  it('accepts dates and offset-qualified timestamps', () => {
    assert.ok(isIsoTimestamp('2026-08-28'));
    assert.ok(isIsoTimestamp('2026-08-28T18:20:00Z'));
    assert.ok(isIsoTimestamp('2026-08-28T18:20:00.123Z'));
    assert.ok(isIsoTimestamp('2026-08-28T18:20:00+02:00'));
  });

  it('rejects prose, bare times and impossible dates', () => {
    assert.ok(!isIsoTimestamp('yesterday'));
    assert.ok(!isIsoTimestamp('2026-08-28T18:20:00'));
    assert.ok(!isIsoTimestamp('2026-13-45'));
  });
});

describe('title rules from SPEC.md section 2.1', () => {
  it('rejects a body with two H1s', () => {
    const source = VALID_HANDOFF.replace('# Rate limiting on /search', '# One\n\n# Two');
    assert.ok(codes(validateHandoffSource(source).errors).includes('multiple-titles'));
  });

  it('warns when the frontmatter title and the body H1 disagree', () => {
    const source = VALID_HANDOFF.replace('# Rate limiting on /search', '# Something else entirely');
    assert.ok(codes(validateHandoffSource(source).warnings).includes('title-mismatch'));
  });
});
