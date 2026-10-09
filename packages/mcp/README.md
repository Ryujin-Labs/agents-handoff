# ryujin-handoff-mcp

MCP server for [Agents Handoff](https://github.com/Ryujin-Labs/agents-handoff). It lets a
coding agent read change context, read the code behind it, write a validated `HANDOFF.md`,
export its complete Markdown, and receive one from another team — with no terminal and nothing installed
globally.

## Connect it

Claude Code:

```bash
claude mcp add agents-handoff -- npx -y ryujin-handoff-mcp
```

Claude Desktop, Cursor, or any client that uses the same shape:

```json
{ "mcpServers": { "agents-handoff": { "command": "npx", "args": ["-y", "ryujin-handoff-mcp"] } } }
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.agents-handoff]
command = "npx"
args = ["-y", "ryujin-handoff-mcp"]
```

Pass `--root /path/to/repo` in `args` to pin the server to one tree.

## Tools

| Tool | |
|---|---|
| `handoff_context` | Everything deterministic about a change: revision, changed files, signals |
| `handoff_source` | Read specific files, or the diff for them |
| `handoff_write` | Store a finished handoff. Prose in; facts from git; validated and scanned before storing |
| `handoff_receive` | Read a handoff you were sent, narrowed to your target |
| `handoff_export` | Export the complete, validated Markdown and report its local path |
| `handoff_list` · `handoff_read` · `handoff_validate` | Inspect what exists |
| `handoff_setup` | Write `handoff.config.json` (never replaces an existing one unless told to) |

## Prompts

`handoff` and `handoff-receive` — the method, surfaced by most clients as slash commands.

## Boundaries

- **Local files.** Writing, reading, validating, exporting and receiving make no network
  calls. The full Markdown is the output artifact.
- **Processes.** Only `git` is executed, with fixed argument shapes.
- **Paths.** Every path argument is resolved through symlinks and must sit inside the
  project (and under `--root`, when pinned). A handoff's `id` never chooses where a file is
  written. Exports use a safe filename inside the project. Files that exist to hold
  credentials are refused.
- **Credentials.** Documents are scanned for credential-shaped strings before they are
  stored and again before they are exported, and refused if any are found.
- **Results.** Every result is complete in both `content` and `structuredContent`, because
  clients differ on which of the two they show the model.

## License

MIT
