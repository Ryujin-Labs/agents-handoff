# CLI reference

```bash
npm i -g ryujin-handoff
```

Installs `handoff` (and `agents-handoff` as an alias).

Every command works without a config file except `init`, so a developer receiving a handoff
can run `handoff receive` immediately with no setup.

## Interactive or not

On a terminal, a command given nothing to work with asks instead of failing:

| | |
|---|---|
| `handoff` | a menu of what you can do here |
| `handoff create` | walks scope, targets and title |
| `handoff init` | walks project setup |
| `handoff send` | pick a handoff, pick a channel |
| `handoff receive` | offers handoff files it finds nearby |

Prompting is enabled only when **both** stdin and stdout are a TTY. A pipe, a redirect, a
CI job, or a coding agent shelling out therefore gets the non-interactive behaviour with no
configuration — which matters, because a prompt in an agent's Bash tool would hang forever.

`--no-input` forces prompting off anywhere, and is accepted by every command
without being declared. Ctrl+C exits any prompt with code `130` and writes nothing.

Keys: `↑`/`↓` or `j`/`k` to move, `space` to toggle in a multi-select, `enter` to confirm.

---

## `handoff init`

Creates `handoff.config.json` and the `.handoff/` directory.

| Flag | |
|---|---|
| `--project <name>` | Logical project name (default: directory name) |
| `--targets <a,b>` | Consumers this project hands off to |
| `--default-target <name>` | Target assumed when none is given |
| `--identity <name>` | Which consumer this repository is, for handoffs it receives |
| `--language <name>` | Language for handoff prose (default: English) |
| `--gitignore` | Keep handoffs local |
| `--no-gitignore` | Commit handoffs (default) |
| `--claude-code` | Also install the `/handoff` skills |
| `--force` | Overwrite an existing config |

## `handoff context`

Prints everything deterministic about the current change. This is what a coding agent reads.

| Flag | |
|---|---|
| `-t, --target <who>` | Consumer this is for |
| `-n, --note <text>` | What you want the handoff to say |
| `-b, --base <ref>` | Compare against this ref instead of the inferred trunk |
| `-c, --commits <n>` | The last N commits |
| `-s, --since <when>` | Commits since a date expression, e.g. `"3 weeks ago"` |
| `--staged` | Only staged changes |
| `--working` | Only uncommitted changes |
| `-p, --paths <path>` | Limit to these paths (repeatable) - one slice of a mixed tree |
| `--json` | Structured output |

Exits `2` when the revision contains no changes, so a script can notice.

## `handoff create`

Scaffolds a draft from git facts, with `<!-- TODO -->` wherever judgment is owed. Takes all
the revision flags above, plus:

| Flag | |
|---|---|
| `--title <text>` | Handoff title (default: derived from branch or commit) |
| `--id <id>` | Explicit id (default: `YYYY-MM-DD-<slug>`) |
| `--author <name>` | Author to record |
| `--stdin` | Read a finished document from stdin instead of scaffolding |
| `--print` | Print instead of writing |
| `--json` | Structured output, including the path |
| `--force` | Overwrite an existing id |

`--stdin` validates and scans for credentials before storing, and refuses on either.

## `handoff list`

`--inbox` for received handoffs, `--all` for both, `--json` for structured output.

## `handoff show <id|path>`

Accepts an id, an unambiguous partial id, or a path.

`--raw` for the stored Markdown, `--section "Required Actions"` for one section, `--json`.

## `handoff validate <id|path>`

Exits non-zero on any error, on a credential-shaped string, or on any warning with
`--strict`. `--quiet` suppresses warnings. `--json` emits machine-readable issue codes and
reaches the same verdict, with the same exit code — so a CI job that uses it fails exactly
when the human-readable run would.

A document marked anything but `draft` that still contains `<!-- TODO -->` is an error:
it claims to be finished and is not (SPEC.md 2.5).

## `handoff receive <path>`

Validates an incoming handoff, stores a copy under `.handoff/inbox/`, and prints what it
means here — `Required Actions` first, narrowed to your target.

| Flag | |
|---|---|
| `-a, --as <target>` | Which consumer this repository is; defaults to the `identity` config key, never to `defaultTarget` |
| `--no-store` | Do not copy into the inbox |
| `--json` | Structured analysis, including the rendered brief |
| `--quiet` | Only print errors |

A handoff that carries a credential-shaped string is read but not stored, so it cannot end
up committed here; the output names what matched.

## `handoff send <id>`

| Flag | |
|---|---|
| `-c, --channel <id>` | Defaults to the route configured for this handoff's target |
| `--to <where>` | A path, a phone number, an address, a Trello board email |
| `--link <mode>` | What a message carries: `repo`, `gist` or `none` |
| `--list` | Show the routes for this handoff, and any configuration problems, then stop. Without an id, what the project has set up |
| `--no-open` | Print the link instead of opening an app |
| `--force` | Send despite validation failures, a scaffold, a credential match or a draft status |

| Channel | Kind | |
|---|---|---|
| `file` · `clipboard` · `stdout` | local | Nothing leaves the machine. `file` writes to `.handoff/outbox/` unless `--to` names a place, and never replaces a file that is not a copy of the same handoff |
| `whatsapp` | compose | Opens a short actionable intro; you attach the file if needed, pick the chats and press send |
| `email` | compose | Opens a draft with the summary and required actions; you attach the file if needed, pick the recipients and press send |
| `slack` | push | Posts the summary and required actions to a webhook |
| `discord` | push | Posts the summary with the handoff attached |
| `trello` | push | Creates a card from a webhook, or opens a draft to the board's email address |
| `github` | push | Uploads a secret gist — readable by anyone with the link |

A scaffold straight from `handoff create` is refused: it is the template the agent was
meant to fill in. For a compose channel the result line reads `opened` (or `ready`, when
`--no-open` printed the link instead), never `sent`, because nothing reaches anyone until
you press send in the app. With `--link gist` the handoff is
uploaded to a secret gist first, and the output says so. When the message carries a link,
the line after it says who can read it. When no share link is available, a Markdown copy
named after the handoff is exported to `.handoff/outbox/<handoff-id>.md`, which keeps itself
out of git, and the result shows its full local path.

Email fills a `mailto:` draft with one plain summary and required-actions block. `mailto:`
cannot attach files automatically: manually attach the exported Markdown in your mail
client, choose the recipients, then press send. WhatsApp opens a short actionable intro
with the full share link when available. Otherwise, it reports the named Markdown export
and its local path so you can attach the file manually in the chat. The tool sends no
WhatsApp message. Clipboard paste does not guarantee an attachment in either client.

## `handoff config`

Shows the resolved configuration, with its routes and any configuration problems — a route
to a channel that does not exist or is not set up, an unset `${VAR}`, a webhook written into
the file. `--json`, `--collectors`, `--channels` to inspect;
`--set-project`, `--set-targets`, `--set-default-target`, `--set-identity`,
`--set-language`, `--gitignore`, `--no-gitignore` to change. `--set-default-target` is who
this project sends to; `--set-identity` is which consumer this repository is when it
receives. `--set-language ""` resets to English.

## `handoff install claude-code`

Copies the skills into `.claude/skills/`. `--user` for `~/.claude/skills`, `--force` to
overwrite edited copies.

## `handoff install mcp`

Adds the MCP server to Claude Desktop's configuration, leaving every other server in it
alone. `--print` prints the entry for any other client instead; `--force` replaces an
existing entry that differs.

---

## Exit codes

| | |
|---|---|
| `0` | Success |
| `1` | Error: invalid input, validation failure, credential detected, not found |
| `2` | `handoff context` found no changes in the selected revision |

Set `HANDOFF_DEBUG=1` for stack traces.
