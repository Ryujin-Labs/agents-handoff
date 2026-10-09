# Releasing

The four public packages share a version and are published in dependency order:
`ryujin-handoff-core`, `ryujin-handoff-claude-code`, `ryujin-handoff-mcp`, then
`ryujin-handoff`. These unscoped packages use npm's free public package route.
Do not install or publish the unrelated `agents-handoff` registry package.

## Before a release

1. Set the new version in all four package manifests, their `ryujin-handoff-*`
   dependency ranges, `packages/integrations/claude-code/.claude-plugin/plugin.json`,
   `.claude-plugin/marketplace.json`, and `packages/integrations/codex/.codex-plugin/plugin.json`.
2. Update the lockfile and add the release to `CHANGELOG.md`.
3. Review and commit the source. Tags do not publish automatically.

Use the intended release version in the commands below:

```bash
npm ci
node scripts/release.mjs --check --version 0.1.0
```

The script runs `npm run release:check`, packs each workspace into a temporary
tarball, checks its contents, and reads the public registry. Only an explicit
registry `404 Not found` establishes absence; outages, authentication failures,
redirects, and invalid responses stop the release. Available names are not reserved
until npm accepts publication.

## Publishing

Local publication does not consume GitHub Actions minutes. Use an existing
authorized npm session and verify its username without printing credentials:

```bash
npm whoami --registry=https://registry.npmjs.org/
```

If authentication is missing, the account holder should authenticate securely in
their own terminal. Do not paste tokens or passwords into chat, commit credentials,
or buy a subscription. Replace `YOUR_NPM_USER` with the exact authenticated user:

```bash
node scripts/release.mjs --publish --expected-user YOUR_NPM_USER --version 0.1.0
```

The script verifies identity before release checks and completes validation and
registry preflight for every package before publishing any. For an existing
package, the authenticated account must appear in the public registry's
`maintainers`. If scoped names are introduced later, it also verifies the account's
personal scope or organization membership. Team-only access without a matching
public maintainer entry is conservatively rejected. npm still enforces token
publish permission and any 2FA requirements. The script does not log in, store
credentials, or grant access.

Publication explicitly sets npm's public registry and `--access=public`. The script
publishes the exact tarballs it checked, then verifies registry maintainers and
SHA-512 integrity. Reruns skip a version only when the expected account maintains
the package and its published tarball matches the current tarball byte for byte.
Different contents require a new shared version; existing versions cannot be
overwritten. After a partial release, resolve the reported error and rerun from
the same source checkout.

## GitHub Actions and source push

`.github/workflows/release.yml` has no push or tag trigger. Optional manual dispatch
requires the exact version, expected npm username, and acknowledgment that Actions
billing controls prevent charges. This acknowledgment does not inspect billing or
make a run free: do not dispatch until spending controls or remaining included
minutes are verified. Use local publication when included minutes are exhausted.

Manual dispatch uses an existing `NPM_TOKEN` repository secret and npm provenance.
Creating a token, repository secret, or trusted-publisher grant requires account
holder approval. Local publication does not claim CI provenance.

Other workflows still run on source pushes and pull requests. When zero-cost
execution cannot be verified, use a commit message containing `[skip ci]` for a
branch push, and avoid opening a pull request that can trigger billable jobs.
Inspect all workflow triggers and billing controls before pushing.

## After publishing

- Install and smoke test the exact published version in a temporary directory:

  ```bash
  npm install --prefix /tmp/ryujin-handoff-smoke --registry=https://registry.npmjs.org/ ryujin-handoff@0.1.0
  /tmp/ryujin-handoff-smoke/node_modules/.bin/handoff --version
  npx --registry=https://registry.npmjs.org/ --yes --package=ryujin-handoff-mcp@0.1.0 agents-handoff-mcp
  ```

  The MCP server uses stdio. Send `initialize`, `notifications/initialized`, and
  `tools/list` messages, confirm valid responses, then stop it.
- Verify public registry versions and actual maintainers for all four packages,
  and record their npm URLs and the source commit in the release notes.
- Both plugins are served from this repository's default branch: once it is pushed,
  `/plugin marketplace add Ryujin-Labs/agents-handoff` (Claude Code) and
  `codex plugin marketplace add Ryujin-Labs/agents-handoff` (Codex) install the new
  version. Validate them first with `claude plugin validate .` and Codex's plugin validator.
- Create a GitHub release from the tag, with the changelog entry as its notes.

References: [npm public packages](https://docs.npmjs.com/about-public-packages),
[npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/), and
[GitHub workflow skipping](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/skipping-workflow-runs).
