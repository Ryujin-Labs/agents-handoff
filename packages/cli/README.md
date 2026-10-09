# ryujin-handoff

The `handoff` CLI for [Agents Handoff](https://github.com/Ryujin-Labs/agents-handoff) —
structured software-change handoffs between developers and their coding agents.

```bash
npm i -g ryujin-handoff
handoff            # an interactive menu
handoff init       # set up this repository
```

After finishing a change:

```bash
handoff context --target mobile     # the deterministic brief a coding agent reads
handoff create  --target mobile     # a draft with real git facts, for an agent to finish
handoff validate <id> --strict
handoff send <id> --list            # where this project sends things
handoff send <id>                   # deliver through the configured route
```

On the receiving side:

```bash
handoff receive ~/Downloads/2026-08-28-auth-refresh-v2.md --as mobile
```

Your agent does the writing. Connect it with the MCP server (`ryujin-handoff-mcp`) or the
Claude Code plugin, and it can do all of the above without a terminal.

Full reference: [`docs/cli.md`](https://github.com/Ryujin-Labs/agents-handoff/blob/main/docs/cli.md).

## License

MIT
