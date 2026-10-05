import { tidyMarkdown } from '../util/text.ts';
import {
  ARGUMENT_GUIDANCE,
  AUTHORING_INTRO,
  AUTHORING_STEPS,
  RECEIVING_INTRO,
  RECEIVING_STEPS,
  type Step,
} from './steps.ts';

/**
 * What a surface contributes for one step: the concrete moves.
 *
 * A bare string goes before the shared prose, which is the usual order — do this, and here
 * is how to judge it. `{ after }` is for the steps where the mechanics are the closing
 * action rather than the opening one.
 */
export type StepMechanics = string | { before?: string; after?: string };

/**
 * Keyed by step id. A surface that has nothing to add for a step omits it, and the shared
 * prose stands alone.
 */
export type Mechanics = Readonly<Record<string, StepMechanics | undefined>>;

export interface RenderOptions {
  mechanics: Mechanics;
  /** Rendered under the intro: what this run was asked to do. */
  situation?: string[];
  /** Appended after the last step. */
  closing?: string;
}

function renderSteps(steps: readonly Step[], mechanics: Mechanics): string[] {
  return steps.map((step, index) => {
    const entry = mechanics[step.id];
    const how = typeof entry === 'string' ? { before: entry } : (entry ?? {});
    const parts = [`## ${index + 1}. ${step.title}`, ''];
    if (how.before?.trim()) parts.push(how.before.trim(), '');
    parts.push(step.body, '');
    if (how.after?.trim()) parts.push(how.after.trim(), '');
    return parts.join('\n');
  });
}

/** The full authoring method, with one surface's mechanics woven in. */
export function renderAuthoringGuide(options: RenderOptions): string {
  const parts = [AUTHORING_INTRO, ''];
  if (options.situation?.length) parts.push(...options.situation, '');
  parts.push(ARGUMENT_GUIDANCE, '');
  parts.push(...renderSteps(AUTHORING_STEPS, options.mechanics));
  if (options.closing) parts.push(options.closing);
  return tidyMarkdown(parts.join('\n'));
}

/** The full receiving method, with one surface's mechanics woven in. */
export function renderReceivingGuide(options: RenderOptions): string {
  const parts = [RECEIVING_INTRO, ''];
  if (options.situation?.length) parts.push(...options.situation, '');
  parts.push(...renderSteps(RECEIVING_STEPS, options.mechanics));
  if (options.closing) parts.push(options.closing);
  return tidyMarkdown(parts.join('\n'));
}
