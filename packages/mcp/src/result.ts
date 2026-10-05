import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Issue } from 'agents-handoff-core';

/**
 * The SDK's own result type rather than a hand-rolled one: the callback signature accepts
 * a union, and a structurally-similar local interface silently matches the wrong arm.
 */
export type ToolResult = CallToolResult;

export interface ResultOptions {
  /**
   * The structured part already carries everything the text says, so the text need not
   * travel inside it. Only for results whose text is a rendering of that same data.
   */
  structuredIsComplete?: boolean;
}

/**
 * A result the model can read whichever part its client shows it.
 *
 * A result may carry `content` (text, for the model) and `structuredContent` (data, for
 * programs), and clients differ on which of the two reaches the model: Claude Code shows
 * the structured part whenever there is one. A structured part that leaves out what the
 * text says is therefore a result some agents never see — the document behind
 * handoff_read, the brief behind handoff_receive, the next step behind handoff_write.
 * So the text travels inside the structured part as well, unless the structured part
 * already is the whole answer.
 */
function withText(
  text: string,
  structured: Record<string, unknown> | undefined,
  options: ResultOptions,
): Record<string, unknown> | undefined {
  if (structured === undefined) return undefined;
  if (options.structuredIsComplete) return structured;
  return { ...structured, text };
}

export function textResult(
  text: string,
  structured?: Record<string, unknown>,
  options: ResultOptions = {},
): ToolResult {
  const data = withText(text, structured, options);
  return data === undefined
    ? { content: [{ type: 'text', text }] }
    : { content: [{ type: 'text', text }], structuredContent: data };
}

/**
 * An error the agent is expected to act on.
 *
 * Returned as a tool result rather than thrown, because a thrown error reads to a model as
 * "the tool is broken" while a result reads as "here is what to fix" — and almost every
 * failure here is the second kind.
 */
export function errorResult(
  text: string,
  structured?: Record<string, unknown>,
  options: ResultOptions = {},
): ToolResult {
  const data = withText(text, structured, options);
  return data === undefined
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }], isError: true, structuredContent: data };
}

export function formatIssueList(issues: readonly Issue[]): string {
  return issues
    .map((issue) => `- ${issue.path ? `[${issue.path}] ` : ''}${issue.message} (${issue.code})`)
    .join('\n');
}

/** Wrap a handler so an unexpected throw still reaches the agent as readable text. */
export function guard(handler: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  return Promise.resolve()
    .then(handler)
    .catch((error: unknown) => errorResult((error as Error).message ?? String(error)));
}
