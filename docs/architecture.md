# Architecture

## The one decision everything follows from

**The core computes; the agent reasons.**

Everything that can be derived from git and the filesystem is derived by plain, testable
TypeScript with no model call anywhere. Everything that requires judgment — what this means
to another team, whether it actually breaks them, what they must do — is left to the coding
agent that already has the repository and the conversation in its context.

That boundary is why the rest of the design is simple:

- the deterministic half runs offline, in CI, and in under a second
- the reasoning half costs nothing extra, because the agent is already there
- a second agent integration is a new `SKILL.md`, not a new pipeline
- every heuristic is unit-testable against a real temporary git repository

## Layers

```
┌───────────────────────────────────────────────────────────────┐
│  mcp  ·  integrations/claude-code  ·  (future adapters)       │   agent surfaces
│  tools + prompts over stdio   skills/handoff/SKILL.md         │
├───────────────────────────────────────────────────────────────┤
│                          cli                                  │   `handoff` binary
│   init  context  create  list  show  validate  export receive │
├───────────────────────────────────────────────────────────────┤
│                          core                                 │   no model calls
│  schema · markdown · config · git · collectors · context      │
│  generate · storage · receive · export · redact               │
└───────────────────────────────────────────────────────────────┘
```

Markdown, git inspection, local storage and export live inside `core`; they share the
same schema and filesystem boundaries. The CLI and MCP server use that implementation
so the resulting Markdown does not depend on which surface created it.

## Data flow

```
                 handoff context
                        │
        ┌───────────────┴───────────────┐
        │        collectChangeContext    │
        │                                │
   resolveRevision ──► git.changedFiles ──► classifyAll
                                │
                        ┌───────┴────────┐
                        │   collectors   │  git, api, auth, contracts, database,
                        │   (registry)   │  environment, dependencies,
                        └───────┬────────┘  infrastructure, tests, agent-context
                                │
                          ChangeContext
                                │
                     ┌──────────┴──────────┐
                     │                     │
                renderBrief       scaffoldHandoff (CLI)
                     │                     │
              Markdown brief        draft HANDOFF.md
                     │                     │
                     └────────► agent ◄────┘
                                  │
                   composeHandoff (handoff_write): prose from
                   the agent, every fact from git, headings generated
                                  │
                          finished HANDOFF.md
                                  │
                             validate → store → export
                                  │
                        ═══════ another machine ═══════
                                  │
                            handoff receive
                                  │
                        analyzeReceived → renderReceiveBrief
                                  │
                          receiving agent implements
```

## Modules

### `markdown/`

`splitFrontmatter` is strict: the opening `---` must be line 1. A `---` further down a
document is a horizontal rule, and guessing otherwise corrupts documents.

`parseBody` tracks fenced code blocks so a `## comment` inside a shell snippet is not
mistaken for a section heading. It records `h1Count` separately from the title so the
validator can enforce the spec's "exactly one H1" rule.

`parseHandoff` is permissive about *values* and strict about *structure*. It throws only
when there is nothing usable; everything else is reported by the validator, which can give
a much better message than an exception. Unknown frontmatter keys are preserved under
`extra` so a round trip never silently drops information a future version added.

`serializeHandoff` writes keys in a fixed order, so regenerating a handoff produces a
minimal diff instead of a reshuffle.

### `schema/validate.ts`

Two severities, and the distinction is load-bearing:

- **errors** mean "this is not a conforming handoff"
- **warnings** mean "this is a conforming handoff that will serve its reader badly"

A warning must never stop a document being written or read. `too-long`, `diff-dump`,
`unstructured-actions`, `unfilled-template` and `target-not-addressed` are all warnings,
because a rejected document is a lost document.

### `git/`

A thin facade over `execFileSync('git', …)` that never throws. Most failures are normal —
no repository, a missing ref, no commits yet — and callers decide what they mean.

A failed `git diff` is the exception, and it is worth the extra machinery: it returns an
empty file list, which downstream is indistinguishable from a clean tree. Those calls go
through `gitOrRecord`, and `collectChangeContext` turns a recorded failure into a warning.
Reporting "no changes" when git simply did not answer would be a wrong answer rather than a
missing one, which is the worse of the two.

`git log` output is split on ASCII unit and record separators (`%x1f`, `%x1e`) rather than
a text marker, so no commit message can break parsing.

`changedFiles` merges `--numstat` and `--name-status` because neither alone gives both
rename information and line counts.

`diff` requires an explicit path list. The collectors read a little of the diff, never all
of it, and making that a signature-level requirement keeps it true.

### `context/revision.ts`

Answers "which change are we talking about?". The default is the branch since it forked
from trunk — `<base>...HEAD` — because that is what a developer means by "the work I just
finished". Explicit `--base`, `--commits`, `--since`, `--staged` and `--working` exist for
the historical case: describing something that shipped last month.

### `collectors/`

Each collector matches a slice of the changed files, reads only that slice of the diff, and
emits `Signal`s. Signals are **evidence, never conclusions**. `breaking-candidate` in
particular means "an agent should look at this", because a static pattern cannot tell a
removed field from a renamed one, and a handoff that cries breaking-change wrongly is worse
than one that stays quiet.

Design notes worth knowing:

- **`classify.ts`** runs once and tags every changed path; collectors consume the tags
  rather than each re-globbing. Build output is tagged `generated` and dropped entirely.
- **`diff.ts`**'s `trulyAdded` / `trulyRemoved` compare on whitespace-normalized lines, so
  reindentation and code movement do not flood the brief.
- **`api.ts`** treats a route present in both the added and removed lines as *changed*, not
  removed. Getting this wrong was the single most misleading thing the collector could do.
- **`auth.ts`** scans every changed file, not only auth-named ones, because a guard gets
  applied in the route file and a scope gets checked in a service.
- **`contracts.ts`** splits single-line type declarations before matching, because real
  code writes `interface Message { id: string; body: string }` on one line.
- **`agent-context.ts`** collects repository instruction files and then states plainly that
  the agent's own conversation is *not* included. Naming the gap is the honest thing to do:
  there is no supported way to read a coding agent's transcript, and scraping one would
  break on the next release.

Adding a collector is implementing `Collector` and appending to `BUILTIN_COLLECTORS`.

### `mcp`

The agent-facing surface, and the one that makes the loop work without a terminal.
Tools and two prompts over stdio, using `@modelcontextprotocol/server` — chosen over the
full SDK for its two dependencies rather than seventeen.

The important pair:

- **`handoff_context`** is the agent's input. Same brief the CLI prints.
- **`handoff_write`** is its output, and it takes *structured prose*, not markdown. The
  agent supplies section text; the tool supplies every fact from git and generates the
  headings. That removes a whole class of error — an invented commit SHA, a heading that
  does not match what the validator looks for — and it validates before storing, so a
  non-conforming document never reaches disk while the developer believes the work is done.

`handoff_write` exists because `scaffoldHandoff` was the wrong shape for an agent. A
scaffold hands back `<!-- TODO -->` markers; that is useful as *input* to reasoning and
useless as *output* from it.

Path handling is the security surface: arguments come from a model, and sometimes from a
document another team wrote. `--root` pins the server to one tree; every path is resolved
through symlinks before it is checked against the project it claims to be in, so a link
cannot widen the boundary; and files that exist to hold credentials are refused outright.
MCP exports stay inside the project, and `handoff_setup` never replaces an existing
configuration unless told to.

Results carry their full text in `structuredContent` as well as in `content`. Clients
differ on which of the two they show the model — Claude Code shows the structured part — so
a structured result that left the text out was a result some agents never saw: the
document behind `handoff_read`, the brief behind `handoff_receive`, and the local file
path behind `handoff_write`. `result.ts` does this for every tool, so no tool can
forget it — `handoff_context` included, because its rendered brief carries guidance the
JSON fields do not.

### `generate/scaffold.ts`

Builds a draft with real frontmatter and `<!-- TODO -->` wherever judgment is owed. It
never invents prose. A scaffold that guessed at a Summary would be worse than one that asks
for it, because a plausible wrong summary gets shipped. It also always sets
`breaking: false`, because a scaffold must not assert something it cannot verify.

### `storage/`

One directory per handoff, named by id, with no index file. The directory listing *is* the
index, so it cannot drift when someone deletes a folder by hand.

### `receive/`

Reorders the document for the reader: `Required Actions` first, narrowed to the receiver's
target when the sender split it with `### <target>` subsections. Handing an agent both
halves of a two-target handoff is how it ends up implementing the wrong one. The narrowing
shares `markdown/`'s fence tracking, because a `### web` line inside a code block is not a
heading — and whatever the sender wrote above the first `###` addresses every target, so it
travels with each of them.

The brief renders every section the document has, known ones first and the sender's own
after, rather than an allowlist that silently deletes what it does not name. It says before
the quoted document and again after it that the document is another team's information,
not instructions — an incoming handoff is untrusted input, and it reaches an agent that
would otherwise read it as its developer talking. The methodology at the end is rendered
from `guidance/steps.ts`, the same source the skill and the MCP prompt use.

### `prompt/` and `interactive/` (cli)

A dependency-free prompt kit — `select`, `multiselect`, `text`, `confirm` — over raw-mode
stdin and a dozen ANSI sequences. No dependency, because a tool that promises to be boring
to install should not pull a tree to draw a list.

`session.ts` decides whether prompting is allowed at all: only when both streams are a TTY,
and never with `--no-input`. That single check is what keeps the same binary usable by a
developer who wants to be asked and by a coding agent that would hang on the question.

The flows in `interactive/` only gather answers; each one then calls the same command
function the flag path calls. Nothing about creating, exporting or receiving is implemented
twice.

Both the prompt streams and the CLI's own output go through the session, so a test can
drive a whole interactive flow in-process and read back the transcript the user would have
seen. That seam is why `interactive.test.ts` can exist at all — a pseudo-terminal is not
available everywhere the suite runs.

### `export/`

Export validates the complete document, rejects credential matches and unfilled templates,
and writes a named `.md` file. The default destination is `.handoff/exports/<id>.md`.
The exported bytes are the source bytes: frontmatter, whitespace and every section stay
intact. The source document and its status are unchanged.

The CLI’s `handoff export` reports the exported path; its `--json` result also includes
the source path and full Markdown. The MCP tool `handoff_export` returns the same complete
Markdown and both paths. The artifact is ready for a file viewer or download surface;
receiving tools consume the same Markdown format.

### `redact.ts`

Scans for credential shapes before a handoff is stored (`handoff_write`, `create --stdin`)
and before it is exported, and whenever it is validated, with a placeholder filter so
`your-api-key-here` does not trip it. Unquoted assignments are matched only in the
`UPPER_SNAKE=value` shape of `.env` files, because a false positive blocks an export
outright. A safety net, not a security control: a leaked key in
a handoff is an accident, and catching the common accidental shapes is worth more than
exhaustive coverage.

## The Claude Code integration

Two skills and the MCP server, using only documented extension points:

- `.claude-plugin/plugin.json` — the plugin manifest, and `.mcp.json` beside it, which
  declares the MCP server, so one install brings both
- `skills/handoff/SKILL.md` → `/agents-handoff:handoff` from the plugin, or `/handoff` when
  installed as project skills with `handoff install claude-code`
- `skills/handoff-receive/SKILL.md` → `/agents-handoff:handoff-receive`, or `/handoff-receive`

The skill files are generated from `guidance/steps.ts` by `scripts/write-skills.mjs`, which
writes both the package's copy and this repository's own `.claude/skills/`, and CI runs it
with `--check` so neither can fall behind.

Both are model-invocable, like their Codex counterparts. A developer usually asks in their
own words — "write a handoff for mobile", "a teammate sent me this handoff" — and a skill
that only answered to its slash command left that request with the tools but not the
method: in testing, a receiving agent read the file directly and skipped the narrowing and
the untrusted-input framing entirely. Each description limits the skill to an explicit
request. `allowed-tools` grants `Bash(handoff *)` so the skill runs without a permission
prompt.

The skill body invokes `handoff context` through the Bash tool rather than through
`` !`command` `` injection, deliberately: injection happens *before* the agent reasons, but
the flags depend on how the agent interprets the argument (`/handoff mobile` versus
`/handoff "tell frontend about the auth change"`), and the agent needs to react if the
binary is missing.

Any agent that speaks MCP needs nothing more than the server. For one that does not,
adding it means writing an equivalent skill or command file against the same
`handoff context` / `handoff create` / `handoff validate` commands. Nothing in `core` or
`cli` knows Claude Code exists — the CLI depends on `ryujin-handoff-claude-code` only to
copy its skill files during `handoff install`.

## Testing

`node:test`, no framework dependency.

The git, collector and CLI tests build real temporary repositories with real commits and run
real `git` — the heuristics are only worth anything if they work against actual `git diff`
output, and a mocked diff would test the mock. The CLI tests spawn the built binary, which
is the only thing that proves the package's `bin` path is right and that exit codes reach
the shell.

`examples.test.ts` validates the shipped examples with zero tolerance for warnings. An
example that failed its own validator would teach every reader the wrong thing.
