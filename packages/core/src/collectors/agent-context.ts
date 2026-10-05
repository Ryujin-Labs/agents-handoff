import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Collector, CollectorResult } from './types.ts';

/** Repository-level instruction files, in the order agents conventionally read them. */
const INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
  'CONTRIBUTING.md',
];

/**
 * The seam where the *calling agent's* knowledge enters the pipeline.
 *
 * Core cannot read a coding agent's conversation, and should not pretend to: there is no
 * officially supported way to extract it, and inventing one would make the tool fragile
 * and untrustworthy. What core can do is name the gap explicitly, so the agent filling in
 * the handoff knows that its own memory of the work is the missing input rather than
 * assuming the brief is complete.
 */
export const agentContextCollector: Collector = {
  name: 'agent-context',
  description: 'Repository instruction files, and the note that agent memory is not included.',
  collect(context): CollectorResult {
    const present = INSTRUCTION_FILES.filter((file) => {
      const path = join(context.root, file);
      return existsSync(path) && statSync(path).isFile();
    });

    const facts: Array<{ label: string; value: string }> = [];
    if (present.length > 0) {
      facts.push({ label: 'repository instructions', value: present.join(', ') });
    }
    facts.push({
      label: 'not included',
      value:
        'The agent conversation that produced this change. If you are the agent that did the work, your own memory of it is the highest-value input here and is not in this brief.',
    });

    return {
      name: 'agent-context',
      summary: null,
      signals: [],
      suggestedReading: present,
      facts,
    };
  },
};
