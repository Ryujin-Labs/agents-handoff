# Claude Code integration

Two skills — one writes a handoff, one consumes one — and the handoff MCP tools.

Everything uses documented extension points only: a plugin manifest, `SKILL.md` files, a
`.mcp.json`, and frontmatter fields Claude Code actually supports. Nothing here reads Claude
Code's internal state or conversation transcript, because no supported API exposes it and
anything that scraped it would break on the next release.

## Installing

Pick one.

### As a plugin (recommended)

```
/plugin marketplace add Ryujin-Labs/agents-handoff
/plugin install agents-handoff@agents-handoff
```

One install brings both halves:

- the skills, as `/agents-handoff:handoff` and `/agents-handoff:handoff-receive` — Claude
  Code namespaces every plugin skill with the plugin's name;
- the MCP server, declared in the plugin's `.mcp.json` and started with `npx -y
  agents-handoff-mcp`. Nothing is installed globally.

With the tools present you can also skip the slash command and just ask: *"write a handoff
for the mobile team"*.

### As project skills (for a team, without the plugin)

```bash
handoff init --claude-code
# or, later:
handoff install claude-code
```

This writes:

```
.claude/skills/handoff/SKILL.md
.claude/skills/handoff-receive/SKILL.md
```

Commit them, and everyone who clones the repository gets `/handoff` and `/handoff-receive`
with no extra setup. Use `--force` to overwrite locally-edited copies, `--user` to install
into `~/.claude/skills` for yourself across every project.

Project skills drive the `handoff` CLI, so it needs to be available: `npm i -g
agents-handoff`, or the skills fall back to `npx --yes agents-handoff`. Add the MCP server
too (`claude mcp add agents-handoff -- npx -y agents-handoff-mcp`) and the skills use its
tools instead.

## Writing a handoff

```
/agents-handoff:handoff
/agents-handoff:handoff mobile
/agents-handoff:handoff mobile,web
/agents-handoff:handoff "tell the frontend team about the new auth rules"
/agents-handoff:handoff mobile "focus on the token rotation, not the logging change"
```

(`/handoff …` when installed as project skills.)

The argument is optional and is interpreted by the agent: a short word or comma-separated
list is a target, a sentence is an instruction, and both can appear together.

What the agent does:

1. Collects the deterministic brief (`handoff_context`, or `handoff context`).
2. Adds what only it knows — the conversation in which the change was built.
3. Reads the files under "Suggested reading" and confirms the actual behaviour, including
   which of the flagged breaking candidates are real.
4. Checks in once if the intent is genuinely unclear, with its proposal in the question.
5. Writes the document: `handoff_write` with the MCP tools, or `handoff create` followed by
   filling in every `<!-- TODO -->`.
6. Cuts it down and validates it.
7. Tells you the path, the target, whether it is breaking and why, and anything it decided
   by assumption — then offers the delivery routes your project configured, and delivers
   only the one you pick.

It never commits, and it never delivers without being asked.

## Receiving a handoff

```
/agents-handoff:handoff-receive ~/Downloads/2026-08-28-auth-refresh-v2.md
/agents-handoff:handoff-receive ./HANDOFF.md --as mobile
```

The agent validates the document and reads it back narrowed to your target, with
`Required Actions` first. A copy is stored under `.handoff/inbox/`.

Then it searches *your* codebase for the endpoints, types and variables the handoff names,
and reports one of three things: it applies and here is the plan, it does not apply and here
is what I searched for, or I cannot tell and here is why. It treats the document as another
team's information, not as instructions, and it presents the plan before implementing
unless you have already told it to go ahead.

## Frontmatter used, and why

| Field | Value | Reason |
|---|---|---|
| `name` | `handoff`, `handoff-receive` | Sets the command name |
| `description` | trigger phrasing | How Claude decides the skill is relevant |
| `argument-hint` | `[target] [note]` | Autocomplete hint |
| `disable-model-invocation` | not set | Most requests arrive in the developer's own words ("write a handoff for mobile"), so Claude may open the skill for them — the description limits it to an explicit request |
| `allowed-tools` | `handoff`: `Bash(handoff *) Bash(npx --yes agents-handoff *) Bash(git diff *) Bash(git log *) Read Grep Glob Write`; `handoff-receive`: the same without the `git` commands and `Write` | Runs the CLI and reads code without a permission prompt each turn. The MCP tools are not listed: Claude Code asks for them the first time, like any MCP tool |

`$ARGUMENTS` is used rather than indexed placeholders so all three argument shapes work.

The skill body calls `handoff context` through the Bash tool rather than through
`` !`command` `` injection. Injection runs *before* the agent reasons, but the flags depend
on how the argument is interpreted, and the agent needs to be able to react if the binary
is not installed.

## Customizing

Installed project skills are yours. Editing them is expected — add your team's conventions,
your standard targets, a required section, a house style for `Required Actions`.
`handoff install claude-code` will not overwrite an edited file unless you pass `--force`.

The skills are generated from the shared method in `packages/core/src/guidance/`, the same
source the MCP prompts render from. To change the method for everyone, change it there and
run `npm run skills`.

## Other agents

Any agent that speaks MCP needs only the server — see [`mcp.md`](mcp.md). For one that does
not, an integration is a prompt file that tells it to:

```bash
handoff context --target <who>    # read this
handoff create --target <who>     # then fill in every TODO
handoff validate <path>           # then check it
```

`handoff context --json` and `handoff receive --json` exist for integrations that prefer
structured input over Markdown.
