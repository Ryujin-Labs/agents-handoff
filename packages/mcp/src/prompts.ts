import { renderAuthoringGuide, renderReceivingGuide } from 'agents-handoff-core';
import { z } from 'zod';

export const handoffPromptArgs = z.object({
  target: z
    .string()
    .optional()
    .describe('Who the handoff is for: mobile, web, frontend, backend, sdk, devops…'),
  project_dir: z.string().optional().describe('Absolute path to the repository.'),
  note: z.string().optional().describe('Anything you want the handoff to say.'),
});

/**
 * How this surface performs each step of the method.
 *
 * Only the mechanics live here. The judgment — what to read for, how to decide `breaking`,
 * what `Required Actions` is for — comes from `agents-handoff-core`, which the Claude Code
 * skill renders from too. Neither surface owns the methodology.
 */
const AUTHORING_MECHANICS = {
  collect:
    'Call `handoff_context`. It is fast, local, and reads nothing outside the repository.\n\nIf the change is not simply "this branch", pass a scope: `base` to compare against another ref, `commits` for the last N, `since` for older work, `working` for uncommitted changes only.\n\nIf the developer did not name the feature or change they want to hand off, or if the brief shows multiple features/areas, ask the developer: "Which feature or change would you like to share?" (or summarize the detected features and ask them to pick/confirm) before calling `handoff_write`.',
  read: 'Call `handoff_source` on the files the brief lists under "Suggested reading". Use `mode: "diff"` where the previous behaviour is not obvious from the current file.',
  compose:
    'Call `handoff_write`. You supply only prose — the schema version, id, timestamp, branch, commit and revision range come from git, and the section headings are generated.\n\nThe document is validated before it is stored. If it does not conform, nothing is written and you get the errors back; fix them and call the tool again.',
  report: {
    after:
      'Call `handoff_delivery_options` for the configured routes, after `handoff_write`. If you generated handoffs for multiple targets (e.g. frontend and backend, or mobile and web), state what was generated for each. Then ask which route to use — one question, with the link choice folded into its options and "let me review it first" among them — with your client\'s question tool if it has one, so the developer can pick rather than type. Call `handoff_deliver` with what they pick. Never deliver automatically or before they choose.',
  },
  check:
    'Ask with your client\'s question tool if it has one, your proposal as the first option; otherwise in one short message. If the tool returns before the developer has answered, stop there: end your turn with at most a line pointing at the question. Do not ask it again as text, and do not start work that depends on the answer.',
} as const;

const RECEIVING_MECHANICS = {
  parse:
    'Call `handoff_receive`, with `as` set to this repository\'s target. Do not skip it by reading the document yourself: this is the step that narrows `Required Actions` to this repository — a handoff for mobile and web carries both sets of instructions — reports validation problems, and keeps a copy under `.handoff/inbox`. It accepts a path inside this project, or the markdown itself; a handoff someone sent usually sits in Downloads, outside the project, so read that file and pass its contents as `markdown`.',
  applies:
    'Use your own file search over this repository. `handoff_source` reads specific files once you know which ones matter.',
} as const;

export function handoffPrompt(args: {
  target?: string | undefined;
  project_dir?: string | undefined;
  note?: string | undefined;
}): string {
  const situation: string[] = [];
  situation.push(
    args.project_dir?.trim()
      ? `Repository: \`${args.project_dir.trim()}\``
      : 'First establish which repository the change is in, and use its absolute path for every tool call.',
  );
  if (args.target?.trim()) situation.push(`Target: \`${args.target.trim()}\``);
  if (args.note?.trim()) situation.push(`The developer said: ${args.note.trim()}`);

  return renderAuthoringGuide({ mechanics: AUTHORING_MECHANICS, situation });
}

export const receivePromptArgs = z.object({
  file_path: z.string().optional().describe('Path to the handoff you were sent.'),
  project_dir: z.string().optional().describe('Absolute path to THIS repository.'),
  as: z.string().optional().describe('Which consumer this repository is.'),
});

export function receivePrompt(args: {
  file_path?: string | undefined;
  project_dir?: string | undefined;
  as?: string | undefined;
}): string {
  const situation: string[] = [];
  situation.push(
    args.project_dir?.trim()
      ? `This repository: \`${args.project_dir.trim()}\``
      : 'Establish the absolute path of this repository first.',
  );
  situation.push(
    args.file_path?.trim()
      ? `The handoff: \`${args.file_path.trim()}\``
      : 'Ask where the handoff is, or have it pasted in — `handoff_receive` accepts either.',
  );
  situation.push(
    args.as?.trim()
      ? `This repository is: \`${args.as.trim()}\``
      : 'Ask which consumer this repository is (mobile, web, sdk…) so Required Actions can be narrowed.',
  );

  return renderReceivingGuide({ mechanics: RECEIVING_MECHANICS, situation });
}

export interface SkillFile {
  name: string;
  contents: string;
}

function skillFrontmatter(name: string, description: string): string {
  return ['---', `name: ${name}`, `description: ${JSON.stringify(description)}`, '---'].join('\n');
}

/**
 * The method as `SKILL.md` files, for agents that load skills and have this server's tools
 * connected — the Codex plugin ships these beside the server.
 *
 * The same text as the prompts above, from the same source, so the surfaces cannot drift.
 * The skills are model-invoked by their description: most requests arrive as a sentence
 * ("write a handoff for mobile"), not as a command.
 */
export function skillFiles(): SkillFile[] {
  const authoring = renderAuthoringGuide({
    mechanics: AUTHORING_MECHANICS,
    situation: [
      'Use the `handoff_*` tools from the agents-handoff MCP server, and the absolute path of the repository the change is in for every call. If the developer named a target (mobile, web, frontend, backend, sdk, devops…) or said what the handoff should say, use that.',
    ],
  });
  const receiving = renderReceivingGuide({
    mechanics: RECEIVING_MECHANICS,
    situation: [
      'Use the `handoff_*` tools from the agents-handoff MCP server, with the absolute path of this repository. If nobody said which consumer this repository is, work it out from the code or ask, so Required Actions can be narrowed.',
    ],
  });

  return [
    {
      name: 'handoff',
      contents: `${skillFrontmatter(
        'handoff',
        'Write a HANDOFF.md describing a software change the developer just finished, for another team and their coding agent. Use when the developer asks to write, create or send a handoff, or to tell another team (mobile, web, frontend, backend, devops...) about a change.',
      )}\n\n# Write a handoff\n\n${authoring}`,
    },
    {
      name: 'handoff-receive',
      contents: `${skillFrontmatter(
        'handoff-receive',
        "Read a HANDOFF.md another team sent and work out what it means for this repository. Use when the developer shares or pastes a handoff, or asks what a teammate's handoff requires here.",
      )}\n\n# Receive a handoff\n\n${receiving}`,
    },
  ];
}
