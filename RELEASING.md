# Releasing

All four packages share one version and are released together.

## Before a release

```bash
npm run release:check
```

That builds everything, runs the full suite, checks the generated skills are current,
validates every example with `--strict`, and packs each workspace without publishing.

Then:

1. Set the new version in all four `packages/*/package.json` files, in their
   `agents-handoff-*` dependency ranges, in `packages/integrations/claude-code/.claude-plugin/plugin.json`,
   `.claude-plugin/marketplace.json` and `packages/integrations/codex/.codex-plugin/plugin.json`.
2. Add the release to `CHANGELOG.md`.
3. Commit, then tag: `git tag v0.1.0`.

## Publishing

Pushing the tag runs `.github/workflows/release.yml`, which publishes with npm provenance.
It needs an `NPM_TOKEN` repository secret with publish rights.

To publish by hand instead, dependencies first:

```bash
npm login
npm publish --workspace packages/core --access public
npm publish --workspace packages/integrations/claude-code --access public
npm publish --workspace packages/mcp --access public
npm publish --workspace packages/cli --access public
```

Each package builds itself before packing (`prepack`), so a stale `dist/` cannot ship.

## After publishing

- Check `npx -y agents-handoff-mcp` starts, and `npm i -g agents-handoff && handoff --version`.
- Both plugins are served from this repository's default branch: once it is pushed,
  `/plugin marketplace add Ryujin-Labs/agents-handoff` (Claude Code) and
  `codex plugin marketplace add Ryujin-Labs/agents-handoff` (Codex) install the new
  version. Validate them first with `claude plugin validate .` and Codex's plugin validator.
- Create a GitHub release from the tag, with the changelog entry as its notes.
