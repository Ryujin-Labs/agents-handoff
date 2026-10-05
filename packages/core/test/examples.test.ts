import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { HANDOFF_FILENAME } from '../src/constants.ts';
import { parseHandoff } from '../src/markdown/parse.ts';
import { serializeHandoff } from '../src/markdown/serialize.ts';
import { findSecrets } from '../src/redact.ts';
import { validateHandoffSource } from '../src/schema/validate.ts';
import { countWords } from '../src/util/text.ts';
import { findUp } from '../src/util/fs.ts';

const repoRoot = findUp('SPEC.md', new URL('.', import.meta.url).pathname);
const examplesDir = repoRoot ? join(repoRoot, 'examples') : null;

function exampleFiles(): Array<{ name: string; path: string; source: string }> {
  if (!examplesDir) return [];
  return readdirSync(examplesDir)
    .filter((name) => {
      const path = join(examplesDir, name, HANDOFF_FILENAME);
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .map((name) => {
      const path = join(examplesDir, name, HANDOFF_FILENAME);
      return { name, path, source: readFileSync(path, 'utf8') };
    });
}

/**
 * The examples are the clearest statement of what a good handoff looks like, so they are
 * held to the standard the tool enforces. An example that fails its own validator would
 * teach every reader the wrong thing.
 */
describe('shipped examples', () => {
  const examples = exampleFiles();

  it('finds the examples directory', () => {
    assert.ok(repoRoot, 'could not locate the repository root');
    assert.ok(examples.length >= 3, `expected at least 3 examples, found ${examples.length}`);
  });

  for (const example of examples) {
    describe(example.name, () => {
      it('is valid with no warnings', () => {
        const result = validateHandoffSource(example.source);
        assert.deepEqual(result.errors, [], JSON.stringify(result.errors, null, 2));
        assert.deepEqual(result.warnings, [], JSON.stringify(result.warnings, null, 2));
      });

      it('round-trips unchanged through parse and serialize', () => {
        const once = serializeHandoff(parseHandoff(example.source));
        assert.equal(serializeHandoff(parseHandoff(once)), once);
      });

      it('is short enough to read in a couple of minutes', () => {
        const words = countWords(example.source);
        assert.ok(words < 900, `${example.name} is ${words} words`);
      });

      it('contains no credentials', () => {
        assert.deepEqual(findSecrets(example.source), []);
      });

      it('constrains the receiving agent rather than only narrating', () => {
        // The section earns its place by saying what *not* to build. A version that only
        // restates the change has failed at the one job this section has.
        const handoff = parseHandoff(example.source);
        const instructions = handoff.sections.find(
          (section) => section.title === 'Instructions for Receiving Agent',
        );
        assert.ok(instructions, 'missing Instructions for Receiving Agent');
        assert.match(
          instructions.content,
          /\bnot\b|\binstead\b|\brather than\b/i,
          'should contain a constraint or a redirection',
        );
      });

      it('has imperative, numbered Required Actions', () => {
        const handoff = parseHandoff(example.source);
        const actions = handoff.sections.find((section) => section.title === 'Required Actions');
        assert.ok(actions);
        assert.match(actions.content, /^\s*(?:###\s|\d+\.\s)/m);
      });
    });
  }
});
