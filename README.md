# Agents Handoff

[![CI](https://github.com/Ryujin-Labs/agents-handoff/actions/workflows/ci.yml/badge.svg)](https://github.com/Ryujin-Labs/agents-handoff/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ryujin-handoff?label=ryujin-handoff)](https://www.npmjs.com/package/ryujin-handoff)
[![npm](https://img.shields.io/npm/v/ryujin-handoff-mcp?label=ryujin-handoff-mcp)](https://www.npmjs.com/package/ryujin-handoff-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Git tells you what code changed. Nothing tells the next developer what that change means for them.**

Agents Handoff is an open format and a small, local-first toolkit for closing that gap. Your
coding agent writes a short, structured `HANDOFF.md` about a change you just finished. Your
teammate's agent reads it in *their* repository and knows exactly what to change — and what
not to build.

```
finish a change  →  "write a handoff for mobile"  →  validate  →  export <id>.md  →  their agent reads it
```

- **The tool collects the facts, the agent does the reasoning.** Git history, changed routes,
  auth guards, types, migrations and environment variables are gathered deterministically.
  What they *mean* to another team is written by the agent that built the change with you.
- **Markdown files.** Create, validate, export and read the complete handoff locally.
  The exported file is the artifact another developer or agent consumes.
- **Works where you already are.** Plugins for Claude Code and Codex, an MCP server for any
  other agent, and a CLI for humans and scripts.

---

## Quick start

Requires Node.js 20.10 or later, and git.

### Claude Code

```
/plugin marketplace add Ryujin-Labs/agents-handoff
/plugin install agents-handoff@agents-handoff
```

The plugin brings both the `/agents-handoff:handoff` and `/agents-handoff:handoff-receive`
skills and the handoff MCP tools. In a repository where you just finished a change, ask:

> write a handoff for the mobile team

### Codex

```bash
codex plugin marketplace add Ryujin-Labs/agents-handoff
codex plugin add agents-handoff@agents-handoff
```

The same two skills and the same MCP tools, packaged for Codex. Ask it the same way:
*"write a handoff for the mobile team"*.

### Any MCP client

Claude Code, without the plugin:

```bash
claude mcp add agents-handoff -- npx -y ryujin-handoff-mcp
```

Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`) and other
clients that use the same shape:

```json
{ "mcpServers": { "agents-handoff": { "command": "npx", "args": ["-y", "ryujin-handoff-mcp"] } } }
```

Codex without the plugin (`~/.codex/config.toml`):

```toml
[mcp_servers.agents-handoff]
command = "npx"
args = ["-y", "ryujin-handoff-mcp"]
```

Nothing is installed globally: the client fetches the server on first use.

### The CLI

```bash
npm i -g ryujin-handoff
handoff            # an interactive menu
handoff init       # set up this repository
```

`handoff install claude-code` copies the skills into `.claude/skills/` so a whole team gets
them by cloning, and `handoff install mcp` adds the server to Claude Desktop.

---

## The loop

**1. You finish a change.** Backend work is done: `GET /messages/:threadId` now returns
`403` to non-members, and the list fields were renamed.

**2. Your agent writes the handoff.** It calls `handoff_context` for the deterministic brief,
reads the code that matters with `handoff_source`, adds what it knows from building the
change with you, and stores a finished document with `handoff_write`:

```
.handoff/2026-09-14-message-list-requires-thread-membership/HANDOFF.md
```

If the intent is unclear — two unrelated changes in the working tree, a target it had to
guess, a breaking call the code does not settle — it asks once, with its proposal already in
the question.

**3. Export the Markdown.** The agent calls `handoff_export`, or you run
`handoff export <id>`. It writes the complete document to `.handoff/exports/<id>.md` and
reports the local file path. Open or download that file from your agent’s file view.
You choose how to give the file to the other developer.

**4. Their agent reads it.** In the mobile repository:

> receive this handoff: ~/Downloads/2026-09-14-message-list-requires-thread-membership.md

`handoff_receive` narrows `Required Actions` to *their* target, and their agent searches its
own codebase for the code that consumes the change, reports what actually differs, and —
when asked — implements it.

## What a handoff looks like

```md
---
handoff_version: 1
id: 2026-08-28-auth-refresh-v2
created_at: 2026-08-28T18:20:00Z
status: ready
breaking: true
source:
  project: backend
  branch: feature/auth-refresh
  commit: 71ac931
targets: [mobile, web]
change_type: [api, authentication]
---

# Refresh tokens are now single-use

## Summary

`POST /auth/refresh` now returns a new `refreshToken` and invalidates the one you sent.

## Why This Matters

Clients that keep their original token get logged out mid-session the first time they
refresh after this ships.

## Required Actions

### mobile

1. Read `refreshToken` from the refresh response and persist it in the keychain.
2. Replace the stored token atomically, in the same write as the access token.

## Instructions for Receiving Agent

Find the existing refresh path before writing anything. Modify it. Do not add a second
token store, a new HTTP client, or a global retry interceptor.
```

The frontmatter is the machine contract; the sections are for people and agents. The two
that matter most are **Required Actions** — what the receiver must *do* — and **Instructions
for Receiving Agent** — what it must *not* build. Three complete examples live in
[`examples/`](examples/), and the format is specified in [`SPEC.md`](SPEC.md).

## What your agent gets

| Tool | |
|---|---|
| `handoff_context` | The deterministic brief: revision, changed files, and signals about routes, auth, contracts, migrations, environment and dependencies |
| `handoff_source` | Read the files and diffs behind the brief |
| `handoff_write` | Store a finished, validated handoff — prose in, facts from git |
| `handoff_export` | Export the full, validated Markdown and report its local path |
| `handoff_receive` | Read a handoff someone sent, narrowed to this repository |
| `handoff_list` · `handoff_read` · `handoff_validate` · `handoff_setup` | |

Plus two prompts, `handoff` and `handoff-receive`, carrying the same method as the skills.

`handoff_write` takes **prose only**. The schema version, id, timestamp, branch, commit and
revision range come from git, and the section headings are generated — so they cannot be
misremembered, and they cannot drift from what the validator and the receiving side match
on. The document is validated and scanned for credentials before it is stored; if it fails,
nothing is written and the agent gets the reasons back. It never replaces an existing
handoff unless you chose to update it: a taken id comes back as a question for you.

The core never calls a model. The brief is fast, offline and the same for every agent, and
it says what it cannot know: its last section is titled *"What this brief does not
contain"*.

## Export

The output is one complete Markdown file: frontmatter, summary, required actions,
contracts, verification, and every other section the author wrote.

```bash
handoff validate <id> --strict
handoff export <id>
handoff export ./HANDOFF.md --out ./exports/backend-auth.md
```

Without `--out`, the file is written to `.handoff/exports/<id>.md`. Export checks the
handoff and copies its original bytes, so the result is the full document rather than a
message preview or a shortened summary. It reports the exported path; `--json` also
returns the source path and complete Markdown for automation.

With MCP, ask the agent to call `handoff_export` and show you the exported file. Open or
download it from the client’s file view, then give that Markdown to the receiving agent.
The receiver can use `handoff receive <path> --as mobile` to read the required actions for
its repository.

Handoffs and exports are local files. Use `handoff config --gitignore` to keep `.handoff/`
out of git, or keep them in a private repository when your team wants them versioned.
A file committed to a public repository is public. Review the document before sharing it.

## Security

A handoff you receive was written by another team. The tooling treats it as data:

- **Paths are confined.** The MCP server reads and writes only inside the project it is
  given (and only under `--root`, when pinned), with symlinks resolved before the check —
  including exported Markdown files. A handoff’s `id` never chooses an arbitrary file
  path; exports require a safe id for the filename.
- **Credentials are refused.** Documents are scanned for credential-shaped strings before
  they are stored by `handoff_write` or `handoff create --stdin`, and every handoff is
  scanned again before it is exported. Validation — CLI or MCP — reports what it finds and
  fails. A handoff you receive that carries one is read but not stored, so it is never
  committed here.
  Files that exist to hold secrets — `.env`, keys, `.npmrc`, cloud credentials — are never
  read.
- **Incoming instructions are not commands.** The receiving brief tells the agent to weigh
  the document's claims against its own repository, not to obey it.

See [`SECURITY.md`](SECURITY.md) to report a vulnerability.

## Configuration

`handoff.config.json`, written by `handoff init` and optional everywhere:

```json
{
  "version": 1,
  "project": "backend",
  "targets": ["mobile", "web", "devops"],
  "identity": null,
  "language": null,
  "ask": "when-unclear",
  "gitignore": false
}
```

| Key | |
|---|---|
| `project` | Logical name written into `source.project` |
| `targets` | Consumers this project hands off to, offered in prompts |
| `defaultTarget` | Target assumed by `handoff create` when none is given |
| `identity` | Which consumer *this* repository is — narrows handoffs you receive. Separate from `defaultTarget`, which is who the handoff addresses |
| `language` | Prose language; `null` means English. `##` headings stay English, since they are the machine contract |
| `ask` | When the agent checks in: `when-unclear` (default), `always`, `never` |
| `gitignore` | `true` keeps `.handoff/` out of git |

## CLI

| Command | |
|---|---|
| `handoff init` | Set up the repository (`--claude-code` installs the skills too) |
| `handoff context` | Print the deterministic brief for the current change |
| `handoff create` | Scaffold a draft with real git facts and `<!-- TODO -->` where judgment is owed, or store a finished document with `--stdin` |
| `handoff list` · `show` | List handoffs (`--inbox` for received ones), print one |
| `handoff validate <id\|path>` | Check against the v1 schema (`--strict` fails on warnings) |
| `handoff receive <path>` | Read an incoming handoff (`--as mobile` to narrow it) |
| `handoff export <file\|id>` | Export the complete Markdown (`--out` chooses the local path; `--json` returns paths) |
| `handoff config` | Show or change settings, and report configuration problems |
| `handoff install claude-code\|mcp` | Install the skills, or add the MCP server to Claude Desktop |

Run any command with nothing to go on and it asks; give it flags and it never prompts.
Prompting turns on only when both stdin and stdout are a terminal, so an agent shelling out
or a CI job gets the non-interactive behaviour automatically. Full reference in
[`docs/cli.md`](docs/cli.md).

A scaffold from `handoff create` still needs the agent’s prose. Export refuses unfilled
TODO markers, and a document marked `ready` that still carries a TODO fails validation.

## Limitations

This is 0.1. What it does not do yet, plainly:

- **Signals are pattern-based.** Route, contract and migration detection is strongest for
  TypeScript/JavaScript and Python backends. Go, Rails and OpenAPI are partly covered; Django,
  Spring, Ktor, Swift and Kotlin types are not detected yet. The agent reads the code either
  way — the brief is a starting point, never the verdict.
- **Downloads depend on your client.** The tool returns a local Markdown file path.
  Clients with a file view can open or download it; other clients show the path.
- **No acknowledgement tracking.** A handoff does not know whether it was read.
- **Claude Code and Codex are the tested clients**, each with a plugin. Any other MCP client
  works through the server alone.

## Architecture

```
packages/
  core/                        schema, Markdown, git context, collectors, validation,
                               storage, Markdown export, and the shared method. No model calls.
  mcp/                         the MCP server: tools and prompts over stdio
  cli/                         the `handoff` binary
  integrations/claude-code/    the Claude Code plugin and its generated skills
  integrations/codex/          the Codex plugin and its generated skills
```

The method an agent follows — collect, recall, read, check in, compose, cut, report — is
written once in `packages/core/src/guidance/` and rendered into the MCP prompts, the
server's instructions, and both plugins' skills, so the surfaces cannot drift apart. More in
[`docs/architecture.md`](docs/architecture.md) and [`docs/mcp.md`](docs/mcp.md).

## Development

```bash
npm install
npm test                 # build, then the full suite
npm run release:check    # what CI runs before a release
```

The tests run the collectors, the CLI and the MCP server end to end against real temporary
git repositories. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[MIT](LICENSE). Agents Handoff is built and maintained by [Ryujin Labs](https://ryujinlabs.com).
