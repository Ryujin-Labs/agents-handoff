import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderAuthoringGuide, renderReceivingGuide } from '../src/guidance/render.ts';
import { AUTHORING_STEPS, RECEIVING_STEPS, type Step } from '../src/guidance/steps.ts';
import { findUp } from '../src/util/fs.ts';

const repoRoot = findUp('SPEC.md', new URL('.', import.meta.url).pathname);

/**
 * The load-bearing claims of the methodology.
 *
 * Every surface that teaches an agent to write a handoff must carry all of these. They are
 * the things that, if quietly dropped from one copy, would still leave the document
 * looking complete while producing worse handoffs.
 */
const INVARIANTS: Array<[string, RegExp]> = [
  ['breaking candidates are matches, not findings', /regex matches, not findings/i],
  ['read the code, not just the brief', /only the code says what the behaviour now is/i],
  ['Required Actions is the most important section', /most important section/i],
  ['no action required is a valid answer', /no action required/i],
  ['tell the receiving agent what not to build', /building a second implementation/i],
  ['English is the default', /\*\*Write in English\.\*\*/],
  ['breaking is about behaviour, not diff size', /not diff size/i],
  ['never paste a diff', /Never paste a diff/],
  ['the agent contributes its own memory', /highest-value input/i],
];

describe('the shared methodology', () => {
  it('has a step body free of any surface-specific mechanics', () => {
    // A command name in the shared prose is the beginning of the drift this file exists to
    // prevent: the other surface would have to carry a lie.
    for (const step of [...AUTHORING_STEPS, ...RECEIVING_STEPS]) {
      assert.ok(
        !/handoff_(context|write|source|receive|deliver)\b/.test(step.body),
        `${step.id} mentions an MCP tool`,
      );
      assert.ok(
        !/\bhandoff (context|create|validate|send|receive)\b/.test(step.body),
        `${step.id} mentions a CLI command`,
      );
    }
  });

  it('renders every step, numbered, in order', () => {
    const guide = renderAuthoringGuide({ mechanics: {} });
    for (const [index, step] of AUTHORING_STEPS.entries()) {
      assert.ok(guide.includes(`## ${index + 1}. ${step.title}`), `missing ${step.title}`);
    }
  });

  it('places mechanics before the prose by default and after when asked', () => {
    const guide = renderAuthoringGuide({
      mechanics: { collect: 'RUN-THIS', cut: { after: 'THEN-THIS' } },
    });
    const collect = AUTHORING_STEPS.find((step: Step) => step.id === 'collect');
    const cut = AUTHORING_STEPS.find((step: Step) => step.id === 'cut');
    assert.ok(guide.indexOf('RUN-THIS') < guide.indexOf(collect?.body.slice(0, 30) ?? ''));
    assert.ok(guide.indexOf('THEN-THIS') > guide.indexOf(cut?.body.slice(0, 30) ?? ''));
  });

  it('stands alone when a surface supplies no mechanics', () => {
    const guide = renderAuthoringGuide({ mechanics: {} });
    for (const [label, pattern] of INVARIANTS) {
      assert.match(guide, pattern, `shared guidance lost: ${label}`);
    }
  });

  it('includes the situation lines a surface passes in', () => {
    const guide = renderReceivingGuide({
      mechanics: {},
      situation: ['This repository: `/tmp/app`'],
    });
    assert.match(guide, /This repository: `\/tmp\/app`/);
  });
});

describe('both surfaces teach the same method', () => {
  const skillPath = (name: string): string =>
    join(repoRoot ?? '', 'packages/integrations/claude-code/skills', name, 'SKILL.md');

  it('the Claude Code skill carries every invariant', () => {
    const skill = readFileSync(skillPath('handoff'), 'utf8');
    for (const [label, pattern] of INVARIANTS) {
      assert.match(skill, pattern, `SKILL.md lost: ${label}`);
    }
  });

  it('the receiving skill carries the honest-outcomes rule', () => {
    const skill = readFileSync(skillPath('handoff-receive'), 'utf8');
    assert.match(skill, /Do not invent work to justify the handoff/);
    assert.match(skill, /You cannot tell/);
  });

  it('each surface contributes only its own mechanics', () => {
    const skill = readFileSync(skillPath('handoff'), 'utf8');
    assert.match(skill, /handoff context --target/, 'the skill should drive the CLI');
    // The skill may mention that MCP exists, but must not instruct through its tools.
    assert.ok(
      !/Call `handoff_write`/.test(skill),
      'the skill should not carry MCP instructions',
    );
  });
});
