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

- `ryujin-handoff-core` — schema, Markdown, git context, collectors, validation, storage,
  full Markdown export, and the shared method agents follow. No model calls.
- `ryujin-handoff-mcp` — tools and two prompts over stdio.
- `ryujin-handoff` — the `handoff` CLI, interactive when run in a terminal and never when
  driven by an agent.
- `ryujin-handoff-claude-code` — the Claude Code plugin: two skills plus the MCP server.
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
- The agent shows the Required Actions it wrote and the path to the finished Markdown,
  so the developer can review the complete document.
- The context brief includes untracked files, lists only this branch's commits, reports a
  `git` failure instead of an empty change, and warns about uncommitted work a branch
  revision leaves out.

### Export

- `handoff export <file|id>` and `handoff_export` validate and export the complete Markdown
  as a local `.md` file, preserving the source bytes and all sections.
- The default destination is `.handoff/exports/<id>.md`; export returns the destination
  path and source path and leaves the document status unchanged.
- The product generates, validates, exports and consumes local Markdown files.

### Receiving

- Required Actions narrowed to the receiving target, fence-aware, with the shared preamble
  kept for every target. Every section the sender wrote is shown.
- The incoming document is framed as another team's information, not instructions.

### Security

- MCP paths resolved through symlinks before the boundary check; `--root` pinning.
- A handoff's `id` never chooses where a file is written.
- Credential scanning on write, validate and export; a received handoff that carries one
  is read but never stored.

[0.1.0]: https://github.com/Ryujin-Labs/agents-handoff/releases/tag/v0.1.0
