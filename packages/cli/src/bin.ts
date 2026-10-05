#!/usr/bin/env node
import { main } from './cli.ts';

/**
 * Piping into a command that stops reading — `handoff show x | head` — closes stdout
 * under us. Node surfaces that as an unhandled EPIPE and a stack trace, which is a crash
 * report for something the user did deliberately. Exit quietly instead.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
}

const code = await main(process.argv.slice(2), process.cwd());
process.exitCode = code;
