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
| `handoff export` | export a selected handoff as a complete Markdown file |
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

## `handoff export <file|id>`

Exports a complete, validated Markdown file from a stored id, an unambiguous partial id,
or a local file path. The exported bytes match the source document exactly.

```bash
handoff export 2026-08-28-auth-refresh-v2
handoff export ./HANDOFF.md --out ./exports/auth-refresh.md
handoff export 2026-08-28-auth-refresh-v2 --json
```

| Flag | |
|---|---|
| `--out <path>` | Local Markdown file or existing directory; defaults to `.handoff/exports/<id>.md` |
| `--json` | Return `id`, `path`, `source_path`, the complete `markdown`, and `unchanged` |

The command reports the absolute local path to the exported Markdown. `--json` also
includes its source path and full contents. Open that file in your editor or download it
through your agent client’s file view. The full frontmatter and every section are retained,
with no message formatting or summary truncation. Invalid documents, unfilled templates and credential matches are refused.
Export leaves the source document’s status unchanged.

## `handoff config`

Shows the resolved configuration for the project, targets, identity, language and local
storage. `--json` and `--collectors` inspect it;
`--set-project`, `--set-targets`, `--set-default-target`, `--set-identity`,
`--set-language`, `--gitignore`, `--no-gitignore` to change. `--set-default-target` is who
this project addresses; `--set-identity` is which consumer this repository is when it
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
