import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export class PathRefused extends Error {
  override readonly name = 'PathRefused';
}

/**
 * Where this server is allowed to operate.
 *
 * An MCP server takes its arguments from a model, so the directory it is asked to work in
 * is untrusted input. `--root` pins it to one tree; without a root, any existing directory
 * is allowed but writes are still confined to that project's own handoff directory.
 */
export interface Boundary {
  root: string | null;
}

export function boundaryFrom(argv: readonly string[]): Boundary {
  const index = argv.indexOf('--root');
  const value = index >= 0 ? argv[index + 1] : undefined;
  return { root: value ? realPath(value) : null };
}

/**
 * Resolve symlinks, falling back to the nearest existing ancestor when the leaf is not
 * there yet — a path is checked before it is written to, and `/tmp` is a symlink on macOS.
 *
 * Every boundary check below runs on the output. Without it `contains` is arithmetic on
 * strings: a link inside the project points wherever its target is, and the name the caller
 * used says nothing about the file that would actually be opened.
 */
export function realPath(path: string): string {
  let current = resolve(path);
  const trailing: string[] = [];
  for (let hops = 0; hops < 64; hops += 1) {
    try {
      return join(realpathSync(current), ...trailing);
    } catch {
      // A dangling symlink is not a path that does not exist yet: writing to it creates its
      // target, wherever that is. Follow it instead of trusting the link's own name.
      try {
        if (lstatSync(current).isSymbolicLink()) {
          current = resolve(dirname(current), readlinkSync(current));
          continue;
        }
      } catch {
        // Nothing there at all; fall through to the parent.
      }
      const parent = dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return resolve(path);
      trailing.unshift(basename(current));
      current = parent;
    }
  }
  throw new PathRefused(`${path} goes through too many symbolic links.`);
}

/**
 * Refuse a path the server would write to when it lies outside the pinned `--root`.
 *
 * `project_dir` is checked on the way in, but a configuration can put the handoff
 * directory elsewhere — at the git root of a monorepo, say — and every write goes there.
 */
export function assertWithinBoundary(boundary: Boundary, path: string, what: string): void {
  if (boundary.root && !contains(boundary.root, realPath(path))) {
    throw new PathRefused(
      `${what} is ${path}, outside the pinned root ${boundary.root}. Nothing was written.`,
    );
  }
}

/** Resolve and check a project directory supplied by the caller. */
export function projectDir(boundary: Boundary, requested: string | undefined): string {
  const raw = requested?.trim();
  if (!raw) {
    if (boundary.root) return boundary.root;
    throw new PathRefused(
      'project_dir is required. Pass the absolute path of the repository to work in.',
    );
  }
  if (!isAbsolute(raw)) {
    throw new PathRefused(`project_dir must be an absolute path, got "${raw}".`);
  }
  const dir = realPath(raw);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new PathRefused(`No such directory: ${dir}`);
  }
  if (boundary.root && !contains(boundary.root, dir)) {
    throw new PathRefused(
      `This server is pinned to ${boundary.root} and will not work in ${dir}.`,
    );
  }
  return dir;
}

/**
 * Resolve a path that must sit inside the project.
 *
 * Reading source is how an agent confirms what the diff actually did, so it has to be
 * possible — but it is confined to the project, and to files whose contents are the
 * agent's business. Both questions are asked of the resolved path, because the answer for
 * `notes.md` and the answer for the `.env` it points at are not the same answer.
 */
export function insideProject(project: string, requested: string): string {
  const lexical = isAbsolute(requested) ? resolve(requested) : resolve(project, requested);
  const target = realPath(lexical);
  if (!contains(realPath(project), target)) {
    throw new PathRefused(`${requested} is outside ${project}.`);
  }
  if (isSecretish(target) || isSecretish(lexical)) {
    throw new PathRefused(
      `Refusing to read ${relative(project, target)}: it looks like a secrets file.`,
    );
  }
  return target;
}

export function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Directories whose `config` is a credential store rather than project configuration. */
const SECRET_CONFIG_DIRS = new Set(['.aws', '.azure', '.docker', '.git', '.gcloud', '.kube', '.ssh']);

/**
 * Files that exist to hold credentials. A handoff never needs their contents, and a model
 * that asks for them is either confused or being steered.
 *
 * Matched case-insensitively: on a case-insensitive filesystem `.ENV` and `.env` are the
 * same file, so a case-sensitive rule refuses one and hands over the other.
 */
export function isSecretish(path: string): boolean {
  const segments = path.split(/[/\\]/).filter(Boolean);
  const name = (segments[segments.length - 1] ?? '').toLowerCase();
  const parent = (segments[segments.length - 2] ?? '').toLowerCase();

  if (/^\.env(\..*)?$/.test(name) && name !== '.env.example' && name !== '.env.template') {
    return true;
  }
  if (/(^|\.)(pem|key|p8|p12|pfx|ppk|keystore|jks|kdbx)$/.test(name)) return true;
  // direnv and Wrangler secrets, kubeconfig, Terraform variables and state.
  if (/^(\.envrc|\.dev\.vars|kubeconfig)$/.test(name)) return true;
  if (/\.(tfvars|tfstate)(\.json|\.backup)?$/.test(name)) return true;
  // Dotfiles that are nothing but credentials: registry tokens, ftp logins, git passwords.
  if (/^\.(netrc|npmrc|pypirc|dockercfg|git-credentials|pgpass|htpasswd)$/.test(name)) return true;
  // ssh private keys, including the `id_ed25519_work` shapes people actually use.
  if (/^id_(rsa|dsa|ecdsa|ed25519)([._-].*)?$/.test(name)) return true;
  // `.aws/credentials`, `credentials.json`, `secrets.yaml`.
  if (/^(credentials|secrets?)(\.(json|ya?ml|toml|ini|env|txt|csv))?$/.test(name)) return true;
  if (/^(service[-_]?account|gcloud|application_default_credentials)\.json$/.test(name)) {
    return true;
  }
  // Firebase Admin SDK downloads: `<project>-firebase-adminsdk-<id>.json`.
  if (/firebase-adminsdk.*\.json$/.test(name)) return true;
  if (/^config(\.json)?$/.test(name) && SECRET_CONFIG_DIRS.has(parent)) return true;
  return false;
}

/**
 * Whether a file's contents are a credential, whatever it is called. Names are a
 * convention; a private key saved as `notes.txt` is still a private key.
 */
export function holdsCredential(contents: string): boolean {
  return (
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/.test(contents) ||
    /"type"\s*:\s*"service_account"/.test(contents)
  );
}
