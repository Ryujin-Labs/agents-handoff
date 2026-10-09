# MCP server

`ryujin-handoff-mcp` gives any MCP-speaking agent the whole handoff loop — collect, read,
write, deliver, receive — without a terminal. It runs over stdio and is fetched on first use
by `npx`, so nothing is installed globally.

## Connecting

| Client | |
|---|---|
| Claude Code | `claude mcp add agents-handoff -- npx -y ryujin-handoff-mcp`, or install the plugin, which declares the server for you |
| Claude Desktop | `handoff install mcp`, or add the JSON below to `claude_desktop_config.json` |
| Cursor | the JSON below in `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` |
| Codex | `codex plugin marketplace add Ryujin-Labs/agents-handoff`, then `codex plugin add agents-handoff@agents-handoff` — or the TOML below in `~/.codex/config.toml` |
| anything else | `handoff install mcp --print` prints the entry |

```json
{ "mcpServers": { "agents-handoff": { "command": "npx", "args": ["-y", "ryujin-handoff-mcp"] } } }
```

```toml
[mcp_servers.agents-handoff]
command = "npx"
args = ["-y", "ryujin-handoff-mcp"]
```

### Pinning to one tree

Every tool takes a `project_dir`. To stop the server working anywhere else, pass `--root`:

```json
{ "command": "npx", "args": ["-y", "ryujin-handoff-mcp", "--root", "/Users/me/code/backend"] }
```

## Tools

### Writing

| Tool | What it does |
|---|---|
| `handoff_context` | The deterministic brief for a change: revision, changed files, and signals about routes, auth, contracts, migrations, environment variables and dependencies. Accepts `target`, `note`, `base`, `commits`, `since`, `staged`, `working` and `scope_paths`. Also lists handoffs already written at this commit or recently on this branch. Call it first. |
| `handoff_source` | Up to ten files from the project, as they stand (`mode: "current"`) or as a diff (`mode: "diff"`). How the agent confirms what the brief only suggests. |
| `handoff_write` | Stores a finished handoff. The agent supplies the prose for each section; the id, timestamp, branch, commit and revision range come from git, and the headings are generated. Validated and scanned for credentials first — if it fails, nothing is written and the reasons come back. A taken id is not replaced unless `overwrite: true`; it comes back as a question for the developer: update that handoff, or keep both. |

### Delivering

| Tool | What it does |
|---|---|
| `handoff_delivery_options` | Every channel, whether it is routed to the target, whether it works here and why not, and any configuration problems worth telling the developer about. |
| `handoff_deliver` | Delivers one handoff (`id`) or several (`ids`), each to the route for its own target unless `channel` names one. `link` chooses what a message carries (`repo`, `gist` or `none`); `to` is a path, number or address. Refuses a handoff that does not conform, that is still a scaffold, or that contains a credential. |

The agent is told to ask the developer before delivering, every time. `text` returns the
handoff in the tool result instead of sending it; `stdout` is never offered, because stdout
is this server's protocol stream.

### Receiving

| Tool | What it does |
|---|---|
| `handoff_receive` | Reads a handoff another team sent (`markdown`, or `file_path` inside the project), narrows `Required Actions` to `as` or the project's `identity`, and stores a copy under `.handoff/inbox/`. The brief frames the document as another team's information, not instructions. |

A handoff someone sent usually lands in Downloads, outside the project. The server does not
read outside the project, so the agent reads the file itself and passes its contents as
`markdown`.

### Managing

| Tool | What it does |
|---|---|
| `handoff_list` | Handoffs written here, received here, or both. |
| `handoff_read` | One handoff in full, by id or an unambiguous part of one. |
| `handoff_validate` | Checks a stored handoff or pasted Markdown against the v1 schema. |
| `handoff_setup` | Writes `handoff.config.json`. Never replaces an existing one unless `overwrite: true`. |

## Prompts

`handoff` (arguments `target`, `note`, `project_dir`) and `handoff-receive` (`file_path`,
`as`, `project_dir`) carry the method an agent follows — the same text the Claude Code
skills are generated from. Most clients show them as slash commands; in Claude Code they are
`/mcp__agents-handoff__handoff` and `/mcp__agents-handoff__handoff-receive`.

## Instructions

The server sends a short statement of the loop on `initialize` — call `handoff_context`
first, read the code, ask once if the intent is unclear, write, then offer the configured
routes and deliver only on the developer's word. Clients that support server instructions
put it in front of the model, so a plain sentence like *"write a handoff for mobile"* is
handled the same way as the prompt.

## What a result contains

Every result is complete in both `content` and `structuredContent`. Clients differ on which
of the two they show the model — Claude Code shows the structured part — so the text of each
result also travels in the structured part as `text` — `handoff_context` included, since
its rendered brief carries guidance its fields do not.

Errors come back as results with `isError: true` and a sentence saying what to do next,
rather than as protocol errors, because "the tool is broken" and "here is what to fix" read
very differently to a model.

## Boundaries

- Writing, reading, validating and receiving make no network calls. Only `handoff_deliver`
  can, and only through the channel the developer picked.
- Only `git` is executed, with fixed argument shapes — plus, when delivering, the platform's
  opener, clipboard command, and `gh`.
- Paths are resolved through symlinks and must sit inside the project (and `--root`). A
  handoff's `id` never chooses where a file is written. Files that exist to hold credentials
  are refused.

## Troubleshooting

**The client gives up while the server starts.** The first start downloads the package. Try
again once it has finished, or install it (`npm i -g ryujin-handoff-mcp`) and use
`agents-handoff-mcp` as the command.

**The tools are there but the agent never offers a route.** Configure `routes` in
`handoff.config.json`, or ask it to call `handoff_delivery_options`; it lists what works
even with nothing configured.
