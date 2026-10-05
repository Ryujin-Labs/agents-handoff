import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseHandoff } from '../markdown/parse.ts';
import { prepareOutbox, writeTextFile } from '../util/fs.ts';
import type { HandoffChannel, SendContext, SendResult } from './types.ts';

/**
 * True when the file at `path` is an earlier copy of the handoff with this id.
 *
 * Refreshing a copy is the point of sending to the same place twice. Replacing anything
 * else is not: a mistyped `--to src/app.ts` should be a refusal, not a lost file.
 */
function isCopyOf(path: string, id: string): boolean {
  try {
    return parseHandoff(readFileSync(path, 'utf8')).frontmatter.id === id;
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Copy the handoff to a path of the developer's choosing, so it can be attached to an
 * email, dropped in a shared folder, or committed to another repository.
 */
export const filesystemChannel: HandoffChannel = {
  id: 'file',
  kind: 'local',
  description: 'Copy the handoff to a path or directory.',
  isAvailable: () => true,
  async send(context: SendContext): Promise<SendResult> {
    const id = context.handoff.frontmatter.id;
    // With nowhere named, the caller's outbox rather than the project root, where a stray
    // copy is one `git add -A` away from being committed beside the original.
    const outbox = context.stagingDir ? resolve(context.cwd, context.stagingDir) : null;
    let destination = resolve(context.cwd, context.destination ?? outbox ?? `${id}.md`);
    if (outbox && (destination === outbox || dirname(destination) === outbox)) prepareOutbox(outbox);
    try {
      if (statSync(destination).isDirectory()) {
        destination = join(destination, `${id}.md`);
      }
    } catch {
      // Path does not exist yet; treat it as a file path and let writeTextFile create it.
    }

    if (isSymlink(destination)) {
      return {
        ok: false,
        destination,
        message: `${destination} is a symbolic link. Nothing was written — choose another path, or a directory.`,
      };
    }
    if (existsSync(destination) && !isCopyOf(destination, id)) {
      return {
        ok: false,
        destination,
        message: `${destination} already exists and is not a copy of this handoff. Nothing was written — choose another path, or a directory.`,
      };
    }

    writeTextFile(destination, context.markdown);
    return {
      ok: true,
      destination,
      message: `Wrote ${basename(destination)} to ${destination}`,
    };
  },
};
