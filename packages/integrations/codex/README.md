# Agents Handoff for Codex

A Codex plugin for [Agents Handoff](https://github.com/Ryujin-Labs/agents-handoff): two
skills and the handoff MCP tools, in one install.

```bash
codex plugin marketplace add Ryujin-Labs/agents-handoff
codex plugin add agents-handoff@agents-handoff
```

Then, in a repository where you just finished a change, ask Codex:

> write a handoff for the mobile team

- **handoff** — collects the change from git, reads the code behind it, and stores a
  finished `HANDOFF.md`; then offers the delivery routes your project configured.
- **handoff-receive** — reads a handoff a teammate sent, narrowed to this repository, and
  plans the work.

Both skills are generated from the same method as the MCP prompts and the Claude Code
skills (`packages/core/src/guidance/`), and run the MCP server with
`npx -y ryujin-handoff-mcp`. Requires Node.js 20.10 or later.

MIT
