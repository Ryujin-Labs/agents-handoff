#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org/';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Dependencies first. Publishing a tarball uses the exact bytes checked below.
const WORKSPACES = [
  'packages/core',
  'packages/integrations/claude-code',
  'packages/mcp',
  'packages/cli',
];

function fail(message) {
  throw new Error(message);
}

function npm(args, { capture = false } = {}) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: ROOT,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    // Do not echo captured authentication output, config, or credentials.
    fail(`npm ${args[0]} failed${result.status === null ? '' : ` (exit ${result.status})`}. Resolve the authentication, permission, or network error and rerun.`);
  }
  return result.stdout?.trim();
}

function json(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    fail(`Invalid JSON from ${label}; release stopped.`);
  }
}

export async function readRegistryMetadata(name, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(new URL(encodeURIComponent(name), REGISTRY), {
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail(`Registry lookup failed for ${name}; absence has not been established.`);
  }
  let metadata;
  try {
    metadata = await response.json();
  } catch {
    fail(`Registry returned invalid JSON for ${name} (HTTP ${response.status}); release stopped.`);
  }
  // An outage, authentication failure, redirect, or malformed response is never absence.
  if (response.status === 404 && metadata?.error === 'Not found') return null;
  if (response.status !== 200) {
    fail(`Registry returned HTTP ${response.status} for ${name}; absence has not been established.`);
  }
  if (metadata?.name !== name || typeof metadata.versions !== 'object'
      || metadata.versions === null || Array.isArray(metadata.versions)) {
    fail(`Registry metadata is incomplete for ${name}; release stopped.`);
  }
  return metadata;
}

export function assertOwner(metadata, username, name) {
  if (!metadata) return;
  if (!Array.isArray(metadata.maintainers)
      || !metadata.maintainers.some((maintainer) => maintainer?.name === username)) {
    fail(`${name} exists but ${username} is not a registry maintainer. No further package will be published.`);
  }
}

export function matchesArtifact(published, packed) {
  return published?.name === packed.name && published?.version === packed.version
    && typeof packed.integrity === 'string' && packed.integrity.startsWith('sha512-')
    && published.dist?.integrity === packed.integrity;
}

function registryArgs(name) {
  const scope = name.startsWith('@') ? name.split('/')[0] : null;
  // Override scoped registry configuration as well as the default registry.
  return [`--registry=${REGISTRY}`, ...(scope ? [`--${scope}:registry=${REGISTRY}`] : [])];
}

async function authenticatedUser(expected, packages) {
  const username = json(npm(['whoami', '--json', `--registry=${REGISTRY}`], { capture: true }), 'npm whoami');
  if (typeof username !== 'string' || username !== expected) {
    fail(`Authenticated npm identity does not match the expected user ${expected}. No package will be published.`);
  }
  const scopes = new Set(packages.filter((pkg) => pkg.name.startsWith('@'))
    .map((pkg) => pkg.name.slice(1).split('/')[0]));
  for (const scope of scopes) {
    if (scope === username) continue; // the account's personal scope
    const members = json(npm(['org', 'ls', scope, '--json', `--registry=${REGISTRY}`], { capture: true }), `npm org ls ${scope}`);
    if (!['owner', 'admin', 'developer'].includes(members?.[username])) {
      fail(`Could not verify ${username}'s membership in @${scope}. No package will be published.`);
    }
  }
  console.log(`Authenticated npm maintainer: ${username}`);
  return username;
}

export function parseArgs(args) {
  const options = { publish: false, expectedUser: null, version: null, provenance: false, help: false };
  let mode;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check' || arg === '--publish') {
      if (mode) fail('Choose exactly one of --check or --publish.');
      mode = arg;
      options.publish = arg === '--publish';
    } else if (arg === '--expected-user' || arg === '--version') {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail(`${arg} requires a value.`);
      options[arg === '--expected-user' ? 'expectedUser' : 'version'] = value;
    } else if (arg === '--provenance') options.provenance = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else fail(`Unknown release argument: ${arg}`);
  }
  if (options.expectedUser && !/^[a-z0-9][a-z0-9._-]*$/.test(options.expectedUser)) {
    fail('--expected-user must be an npm username.');
  }
  if (options.publish && !options.expectedUser) fail('--publish requires --expected-user NAME.');
  if (options.provenance && !options.publish) fail('--provenance requires --publish.');
  return options;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log('Usage: node scripts/release.mjs [--check] [--expected-user NAME] [--version VERSION]\n       node scripts/release.mjs --publish --expected-user NAME [--version VERSION] [--provenance]\n\n--check runs local release validation, packs all packages, and checks the public registry.\n--publish additionally verifies the existing npm session and publishes checked tarballs.\nNo login, credentials, subscriptions, or GitHub Actions runs are created.');
    return;
  }
  const packages = await Promise.all(WORKSPACES.map(async (workspace) => {
    const manifest = json(await readFile(join(ROOT, workspace, 'package.json'), 'utf8'), `${workspace}/package.json`);
    if (manifest.private || !manifest.name || !manifest.version) fail(`Invalid public package manifest in ${workspace}.`);
    if (manifest.publishConfig?.registry && manifest.publishConfig.registry.replace(/\/$/, '') !== REGISTRY.slice(0, -1)) {
      fail(`${manifest.name} has a different publishConfig.registry; release stopped.`);
    }
    if (manifest.publishConfig?.access && manifest.publishConfig.access !== 'public') {
      fail(`${manifest.name} is not configured for public access; release stopped.`);
    }
    return { ...manifest, workspace };
  }));
  const version = packages[0].version;
  if (new Set(packages.map((pkg) => pkg.name)).size !== packages.length
      || packages.some((pkg) => pkg.version !== version)
      || (options.version && options.version !== version)) {
    fail('All four packages must have distinct names and the same requested release version.');
  }
  for (let i = 0; i < packages.length; i++) {
    for (const dependency of packages) {
      const range = packages[i].dependencies?.[dependency.name];
      if (!range) continue;
      if (packages.indexOf(dependency) >= i || ![version, `^${version}`, `~${version}`].includes(range)) {
        fail(`${packages[i].name} has an invalid release dependency on ${dependency.name}.`);
      }
    }
  }
  const username = options.expectedUser ? await authenticatedUser(options.expectedUser, packages) : null;
  // Validate every package before the first registry mutation.
  npm(['run', 'release:check']);
  const directory = await mkdtemp(join(tmpdir(), 'ryujin-handoff-release-'));
  try {
    const artifacts = [];
    for (const pkg of packages) {
      const results = json(npm(['pack', '--workspace', pkg.workspace, '--json', '--pack-destination', directory], { capture: true }), `npm pack ${pkg.name}`);
      const artifact = results?.[0];
      if (results?.length !== 1 || artifact?.name !== pkg.name || artifact.version !== version
          || !artifact.filename || !artifact.integrity?.startsWith('sha512-')
          || !Array.isArray(artifact.files) || !artifact.files.some((file) => file.path === 'LICENSE')
          || !artifact.files.some((file) => file.path.startsWith('dist/src/'))
          || artifact.files.some((file) => file.path.includes('/test/'))) {
        fail(`Unexpected npm pack contents or metadata for ${pkg.name}; release stopped.`);
      }
      artifacts.push({ ...artifact, tarball: join(directory, artifact.filename) });
    }
    // Preflight all packages before publishing any; only explicit registry 404 means absent.
    for (const artifact of artifacts) {
      const metadata = await readRegistryMetadata(artifact.name);
      if (username) assertOwner(metadata, username, artifact.name);
      const published = metadata?.versions[version];
      if (published && !matchesArtifact(published, artifact)) {
        fail(`${artifact.name}@${version} already exists with different bytes. Bump the shared version; it cannot be overwritten.`);
      }
      console.log(`${artifact.name}@${version}: ${published ? 'matching published artifact' : 'not published'}${metadata ? `; maintainers: ${(metadata.maintainers ?? []).map((maintainer) => maintainer.name).join(', ') || '(unknown)'}` : ''}`);
    }
    if (!options.publish) {
      console.log(`Release checks passed. ${username ? 'Identity and current ownership checked.' : 'Authentication and ownership must still be checked when publishing.'} Nothing was published.`);
      return;
    }
    for (const artifact of artifacts) {
      // Recheck immediately before publish: do not ignore a name claimed during preflight.
      const metadata = await readRegistryMetadata(artifact.name);
      assertOwner(metadata, username, artifact.name);
      const published = metadata?.versions[version];
      if (published) {
        if (!matchesArtifact(published, artifact)) fail(`${artifact.name}@${version} changed during the release; stopped.`);
        console.log(`Skipping owned, identical ${artifact.name}@${version}.`);
        continue;
      }
      npm(['publish', artifact.tarball, '--access=public', '--tag=latest', ...registryArgs(artifact.name), ...(options.provenance ? ['--provenance'] : [])]);
      const live = await readRegistryMetadata(artifact.name);
      assertOwner(live, username, artifact.name);
      if (!live || !matchesArtifact(live.versions[version], artifact)) {
        fail(`Published ${artifact.name}@${version}, but registry verification has not succeeded. Inspect the registry before rerunning.`);
      }
      console.log(`Verified https://www.npmjs.com/package/${artifact.name}/v/${version}`);
    }
    console.log(`Public release ${version} verified for all four packages.`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Release stopped: ${error.message}`);
    process.exitCode = 1;
  });
}
