import { renderAuthoringGuide, renderReceivingGuide } from 'ryujin-handoff-core';

/**
 * The Claude Code skills, rendered from the shared methodology.
 *
 * `SKILL.md` has to be a static file — Claude Code reads it from disk — so it is generated
 * rather than hand-written, and a test asserts the committed files match what this
 * produces. That keeps one source of truth without making the skill depend on a round trip
 * to learn how to do its job.
 *
 * Everything below is *mechanics*: which command to run, which tool grant it needs. The
 * judgment lives in `ryujin-handoff-core`, and the MCP prompt renders from the same place.
 */

const AUTHORING_MECHANICS = {
  collect: `Run this first:

\`\`\`
handoff context --target <target> --note "<note>"
\`\`\`

If \`handoff\` is not on PATH, use \`npx --yes ryujin-handoff context ...\`. If neither works, tell the developer to run \`npm i -g ryujin-handoff\` — or to connect the MCP server, which needs no install — and stop.

Useful flags when the work is not simply "this branch":

| Situation | Flag |
|---|---|
| Compare against a different branch or tag | \`--base main\` |
| Describe the last N commits | \`--commits 5\` |
| Describe something from a while ago | \`--since "3 weeks ago"\` |
| Only what is uncommitted right now | \`--working\` |`,

  read: `Open the files the brief lists under "Suggested reading", and enough of their surroundings to be sure. \`git diff\` on a specific path is often faster than reading the whole file.`,

  compose: `\`\`\`
handoff create --target <target> --title "<short title>"
\`\`\`

This writes \`.handoff/<id>/HANDOFF.md\` with the frontmatter already filled in from git — id, timestamp, branch, commit, revision range — and \`<!-- TODO -->\` markers in the body. It prints the path.

Read that file, then rewrite it with the Write tool. **Keep the generated frontmatter as it is**, with three exceptions you set yourself: \`status: ready\`, \`breaking:\`, and a corrected \`change_type:\`.

Every \`<!-- TODO -->\` must be gone. A document that still contains one is a scaffold, not a handoff — \`handoff validate\` rejects a \`status: ready\` document that has one, and \`handoff send\` refuses to deliver it.`,

  cut: {
    after: `Then check it:

\`\`\`
handoff validate <path>
\`\`\`

Fix every error. Warnings are advice — \`too-long\`, \`diff-dump\` and \`unstructured-actions\` in particular are usually telling you something true. If you disagree with one, leave it and say why in your report.`,
  },

  report: {
    after: `See how this project reaches the target, then put the routes to the developer with AskUserQuestion so they can pick rather than type — with "let me review it first" among the options — and deliver the one they pick yourself, rather than handing them a command to run.

With the \`handoff_*\` MCP tools: \`handoff_delivery_options\`, then \`handoff_deliver\` once they have picked. Without them:

\`\`\`
handoff send <id> --list
handoff send <id> --channel <route>
\`\`\`

For whatsapp, email and slack, \`--link\` decides what the message carries — offer it in the same question, with who can read each:

- \`--link repo\` — a link to the handoff where it is committed. Readable by whoever can read the repository; nothing is uploaded. Needs the handoff pushed.
- \`--link gist\` — uploads a secret gist. Unlisted, but readable by anyone who has the URL.
- no link — the file is revealed for the developer to attach.

Never run the send without being asked.`,
  },

  check: `Ask with AskUserQuestion, your proposal as the first option.

When the scope is the problem, \`--paths\` is the fix: \`handoff context --working --paths src/chat\` describes one slice of a mixed working tree, and you can write more than one handoff from the same tree.`,
} as const;

const RECEIVING_MECHANICS = {
  parse: `Do not skip this by reading the document yourself. This step is what narrows \`Required Actions\` to this repository's target — a handoff for mobile and web carries both sets of instructions — reports validation problems, and files a copy under \`.handoff/inbox/\`.

With the \`handoff_*\` MCP tools: read the file, then call \`handoff_receive\` with its contents as \`markdown\` and \`as\` set to this repository's target. Pass \`file_path\` only for a file inside this project.

Without them:

\`\`\`
handoff receive <path> --as <target>
\`\`\`

If the developer pasted the handoff into the conversation rather than giving you a file, pass it as \`markdown\`, or write it to a temporary file for the command.`,

  applies: `Use Grep and Glob over this repository.`,
} as const;

export interface GeneratedSkill {
  name: string;
  contents: string;
}

/**
 * YAML frontmatter with every string quoted.
 *
 * Unquoted, `argument-hint: [target] [note]` is a flow sequence followed by stray text:
 * the whole block fails to parse, and Claude Code then loads the skill with no metadata at
 * all — no description, no `disable-model-invocation`, no `allowed-tools` — without a word.
 * JSON strings are valid YAML double-quoted scalars, so they are used as-is.
 */
function frontmatter(fields: Record<string, string | boolean>): string {
  const line = ([key, value]: [string, string | boolean]): string =>
    `${key}: ${typeof value === 'boolean' ? String(value) : JSON.stringify(value)}`;
  return ['---', ...Object.entries(fields).map(line), '---'].join('\n');
}

export function generateSkills(): GeneratedSkill[] {
  const authoring = renderAuthoringGuide({
    mechanics: AUTHORING_MECHANICS,
    situation: [
      'Arguments: `$ARGUMENTS`',
      '',
      'If the `handoff_*` MCP tools are available in this session — the plugin brings them — use them instead of the commands below: `handoff_write` stores a finished, validated document in one call, with every fact taken from git. The method is the same either way.',
    ],
  });

  const receiving = renderReceivingGuide({
    mechanics: RECEIVING_MECHANICS,
    situation: [
      'Arguments: `$ARGUMENTS` — a path to the handoff file, optionally followed by `--as <target>` naming which consumer this repository is.',
      '',
      'If the `handoff_*` MCP tools are available in this session — the plugin brings them — use them instead of the commands below. They only read files inside this project, and a handoff someone sent usually sits in Downloads, so step 1 says how to pass it. Do not copy the file into the project.',
    ],
  });

  return [
    {
      name: 'handoff',
      contents: `${frontmatter({
        name: 'handoff',
        // Model-invocable, like the Codex skill: a developer usually asks in their own words
        // ("write a handoff for mobile") rather than typing the command. The description
        // keeps it to that request.
        description:
          'Write a HANDOFF.md about a software change the developer finished, for another team and their coding agent. Use when the developer asks to write, create or send a handoff, or to tell another team (mobile, web, frontend, backend, sdk, devops...) about a change; never on your own initiative.',
        'argument-hint': '[target] [note]',
        'allowed-tools':
          'Bash(handoff *) Bash(npx --yes ryujin-handoff *) Bash(git diff *) Bash(git log *) Read Grep Glob Write',
      })}\n\n# Write a handoff\n\n${authoring}`,
    },
    {
      name: 'handoff-receive',
      contents: `${frontmatter({
        name: 'handoff-receive',
        description:
          "Read a HANDOFF.md another team sent, work out what it means for this repository, and plan the work. Use when the developer shares a handoff file (often in Downloads) or pastes one, or asks what a teammate's handoff needs here.",
        'argument-hint': '<path-to-handoff.md> [--as target]',
        'allowed-tools': 'Bash(handoff *) Bash(npx --yes ryujin-handoff *) Read Grep Glob',
      })}\n\n# Receive a handoff\n\n${receiving}`,
    },
  ];
}
