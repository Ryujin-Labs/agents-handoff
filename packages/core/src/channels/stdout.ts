import type { HandoffChannel, SendContext, SendResult } from './types.ts';

/** Where a printed handoff goes. Injected so "standard output" is never assumed. */
export type WriteSink = (text: string) => void;

/**
 * Print the handoff, so it can be piped into anything at all.
 *
 * The sink is a parameter because file descriptor 1 does not always belong to the person
 * reading: under the MCP server it carries JSON-RPC, and a handoff written there destroys
 * the connection it would have reported success on. A host that owns its stdout builds a
 * channel with a sink it can afford.
 */
export function createStdoutChannel(write: WriteSink): HandoffChannel {
  return {
    id: 'stdout',
    kind: 'local',
    description: 'Print the handoff to standard output.',
    isAvailable: () => true,
    async send(context: SendContext): Promise<SendResult> {
      write(`${context.markdown.trimEnd()}\n`);
      return { ok: true, destination: 'stdout', message: '' };
    },
  };
}

/** The channel as the CLI uses it, writing to this process's own stdout. */
export const stdoutChannel: HandoffChannel = createStdoutChannel((text) =>
  process.stdout.write(text),
);
