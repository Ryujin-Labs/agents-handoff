# agents-handoff-claude-code

Claude Code integration for [Agents Handoff](https://github.com/Ryujin-Labs/agents-handoff).

Two skills, plus the handoff MCP tools:

- **handoff `[target] [note]`** — analyze the change you just finished and write a
  `HANDOFF.md` for another team
- **handoff-receive `<path> [--as target]`** — read a handoff someone sent you, work out what
  it means for this repository, and plan the implementation

## Install

As a plugin — skills and MCP tools in one step, nothing installed globally:

```
/plugin marketplace add Ryujin-Labs/agents-handoff
/plugin install agents-handoff@agents-handoff
```

The commands are `/agents-handoff:handoff` and `/agents-handoff:handoff-receive`; with the
tools present you can also just ask for a handoff.

As project skills, committed with your repository so the whole team gets `/handoff` and
`/handoff-receive`:

```bash
npm i -g agents-handoff
handoff install claude-code
```

Project skills drive the `handoff` CLI, or the MCP tools when they are connected.

## Design

Documented extension points only: a `.claude-plugin/plugin.json` manifest, a `.mcp.json`
declaring the MCP server, and `skills/<name>/SKILL.md` files generated from the shared method in
`agents-handoff-core`. Nothing reads Claude Code's internal state or conversation
transcript; the skill asks the agent to contribute what it already remembers about building
the change, which works in any agent rather than just this one.

Details: [`docs/claude-code.md`](https://github.com/Ryujin-Labs/agents-handoff/blob/main/docs/claude-code.md).

## License

MIT
