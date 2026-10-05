# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). The `HANDOFF.md` format is versioned separately,
by `handoff_version` in its frontmatter.

## [0.1.0] — first release

### Format

- `HANDOFF.md` v1: YAML frontmatter as the machine contract, canonical English `##`
  sections for people and agents. Specified in `SPEC.md`.
- `breaking`, `targets` and `change_type` are required and never coerced: `breaking: yes`
  is an error, not a silent `false`.
- A document marked anything but `draft` that still contains `<!-- TODO -->` is
  non-conforming (SPEC.md 2.5).

### Packages

- `agents-handoff-core` — schema, Markdown, git context, collectors, validation, storage,
  channels, and the shared method agents follow. No model calls.
- `agents-handoff-mcp` — ten tools and two prompts over stdio.
- `agents-handoff` — the `handoff` CLI, interactive when run in a terminal and never when
  driven by an agent.
- `agents-handoff-claude-code` — the Claude Code plugin: two skills plus the MCP server.
- The Codex plugin (`packages/integrations/codex`, installed from this repository's
  marketplace): two skills plus the MCP server.
- The MCP server sends instructions on `initialize`, so a plain request ("write a handoff
  for mobile") follows the same loop as the prompts.

### Writing

- `handoff_write` stores a finished handoff from the agent's prose, with every fact taken
  from git, validated and scanned for credentials before it is written.
- The developer decides what happens to a handoff that already exists: the brief lists
  those written at this commit or recently on this branch, and `handoff_write` turns a
  taken id into a question (update it, or keep both) rather than replacing it or filing a
  second copy.
- Before asking where to deliver, the agent shows the Required Actions it wrote and offers
  "let me review it first".
- The context brief includes untracked files, lists only this branch's commits, reports a
  `git` failure instead of an empty change, and warns about uncommitted work a branch
  revision leaves out.

### Delivery

- Channels: `file`, `clipboard`, `stdout` (local); `whatsapp`, `email` (compose — you pick
  the recipients and press send); `slack`, `discord`, `trello`, `github` gist (push).
- Link modes say who can read what they made: `repo` (whoever can read the repository),
  `gist` (anyone with the link), `none`.
- Routes per target, with configuration problems reported instead of silently ignored.

### Receiving

- Required Actions narrowed to the receiving target, fence-aware, with the shared preamble
  kept for every target. Every section the sender wrote is shown.
- The incoming document is framed as another team's information, not instructions.

### Security

- MCP paths resolved through symlinks before the boundary check; `--root` pinning.
- A handoff's `id` never chooses where a file is written.
- Credential scanning on write, validate and deliver; a received handoff that carries one
  is read but never stored.

[0.1.0]: https://github.com/Ryujin-Labs/agents-handoff/releases/tag/v0.1.0
