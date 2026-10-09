# ryujin-handoff-mcp

MCP server for [Agents Handoff](https://github.com/Ryujin-Labs/agents-handoff). It lets a
coding agent read change context, read the code behind it, write a validated `HANDOFF.md`,
receive one from another team, and deliver it — with no terminal and nothing installed
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
| `handoff_delivery_options` | Where this project sends things, what is not set up, and configuration problems |
| `handoff_deliver` | Deliver through a channel — see below |
| `handoff_list` · `handoff_read` · `handoff_validate` | Inspect what exists |
| `handoff_setup` | Write `handoff.config.json` (never replaces an existing one unless told to) |

## Prompts

`handoff` and `handoff-receive` — the method, surfaced by most clients as slash commands.

## Boundaries

- **Network.** Writing, reading, validating and receiving make no network calls. Only
  `handoff_deliver` can reach the network, and only through the channel the developer
  picked: `slack`, `discord` and `trello` post to the webhook you configured, and `github`
  uploads a secret gist through the `gh` CLI. `whatsapp` and `email` open an app and send
  nothing themselves, unless their link mode is `gist` — then the handoff is uploaded as a
  secret gist first, and the result says so. Local channels (`clipboard`, `file`, `text`)
  upload nothing.
- **Processes.** Only `git` is executed with fixed argument shapes — plus, when delivering,
  the platform's opener, clipboard command, and `gh`.
- **Paths.** Every path argument is resolved through symlinks and must sit inside the
  project (and under `--root`, when pinned). A handoff's `id` never chooses where a file is
  written. The `file` channel writes inside the project and never replaces a file that is
  not a copy of the same handoff. Files that exist to hold credentials are refused.
- **Credentials.** Documents are scanned for credential-shaped strings before they are
  stored and again before they are delivered, and refused if any are found.
- **Results.** Every result is complete in both `content` and `structuredContent`, because
  clients differ on which of the two they show the model.

## License

MIT
