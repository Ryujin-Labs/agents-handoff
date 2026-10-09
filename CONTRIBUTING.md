# Contributing

```bash
npm install
npm test                 # build, then the full suite
npm run typecheck
npm run release:check    # everything CI checks before a release
```

Try the CLI against a real repository without installing it globally:

```bash
npm run build
node packages/cli/dist/src/bin.js context --target mobile
```

## Layout

```
packages/core/                     schema, markdown, git, collectors, validation, storage,
                                   Markdown export, and the shared method in guidance/
packages/mcp/                      the MCP server
packages/cli/                      the `handoff` binary
packages/integrations/claude-code/ the plugin and the generated skills
packages/integrations/codex/       the Codex plugin and its generated skills
examples/                          three complete handoffs, validated by the test suite
SPEC.md                            the HANDOFF.md v1 format
docs/                              architecture, CLI, MCP and Claude Code references
website/                           the landing page and the docs site (Astro + Starlight)
```

The docs site is generated from this repository's Markdown — the README's sections,
`SPEC.md`, `docs/` and the rest — so a change there is a change to the site too. Renaming
a README heading the site uses fails the site's build in CI; see
[`website/README.md`](website/README.md).

## Changing what an agent is told

The method — how to collect, read, check in, compose and report — lives once, in
`packages/core/src/guidance/steps.ts`. The MCP prompts render from it at runtime, and the
Claude Code skills are generated from it:

```bash
npm run skills
```

CI fails when a committed `SKILL.md` is stale. Surface-specific instructions (which command
to run, which tool to call) go in that surface's mechanics, never in the shared steps.

## The rule that shapes everything

**Core computes; the agent reasons.** No model call belongs in `packages/core`. If a feature
needs judgment, it belongs in a skill file, not in the pipeline.

## Adding a context collector

Implement `Collector` in `packages/core/src/collectors/`, append it to
`BUILTIN_COLLECTORS`, and add a case to the scenario repository in
`packages/core/test/helpers.ts` so it is exercised against real `git diff` output.

Collectors emit **evidence, not conclusions**. A `breaking-candidate` signal means "an agent
should look at this". If a heuristic cannot distinguish a rename from a removal — and it
cannot — say so in the signal rather than asserting the stronger claim.

Prefer silence over noise. A missed signal costs a line in the brief; a wrong one costs
trust in every other line.

## Changing the format

`SPEC.md` is the contract. Anything that changes it needs:

- the spec updated first
- a round-trip test proving `parse → serialize` is lossless
- new validation rules added as **warnings** unless a document is genuinely non-conforming

Errors mean "this is not a handoff". Warnings mean "this is a handoff that will serve its
reader badly". A rejected document is a lost document, so the bar for a new error is high.

Anything that would change `handoff_version` needs a discussion in an issue first.

## Security-sensitive code

A handoff you receive was written by someone else, and the MCP server's arguments come from
a model. Changes to `packages/mcp/src/paths.ts`, `packages/core/src/storage/`,
`packages/core/src/receive/` or `packages/core/src/redact.ts` need a test that tries the
attack, not only the happy path. See [`SECURITY.md`](SECURITY.md).

## Tests

`node:test`, no framework. Git and CLI tests use real temporary repositories and the real
`git` binary — a mocked diff would test the mock.

The shipped examples are validated with `--strict` on every run. If you change a validation
rule and an example starts warning, fix the example: it is the clearest statement we have of
what good looks like.
