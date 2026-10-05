import {
  deliveryOptions,
  handoffDirectory,
  HandoffStore,
  loadConfig,
  normalizeTarget,
  SUGGESTED_TARGETS,
  type Direction,
  type HandoffConfig,
  type LoadedConfig,
  type StoredHandoff,
} from 'agents-handoff-core';
import { multiselect, select, text, type Choice } from '../prompt/index.ts';
import { style } from '../ui.ts';

const OTHER = Symbol('other');

/**
 * Choose one or more consumers.
 *
 * The project's configured targets come first because they are the ones this team actually
 * hands off to; the general suggestions fill in underneath so a first run is not an empty
 * list, and "something else" keeps the vocabulary open.
 */
export async function pickTargets(
  config: LoadedConfig['config'],
  message = 'Who is this handoff for?',
): Promise<string[]> {
  const known = config.targets.length > 0 ? config.targets : SUGGESTED_TARGETS.slice(0, 6);
  const choices: Array<Choice<string | typeof OTHER>> = known.map((target) => ({
    value: target,
    label: target,
  }));
  choices.push({ value: OTHER, label: 'something else…', hint: 'type a name' });

  const initial = config.defaultTarget ? [config.defaultTarget] : [];
  const chosen = await multiselect<string | typeof OTHER>({
    message,
    choices,
    initial,
    required: false,
  });

  const targets = chosen.filter((value): value is string => value !== OTHER);
  if (chosen.includes(OTHER)) {
    const extra = await text({
      message: 'Name them:',
      placeholder: 'sdk, data, partners…',
      validate: (value) => (value.trim() ? null : 'type a name, or ctrl+c to cancel'),
    });
    for (const part of extra.split(/[\s,]+/).filter(Boolean)) {
      targets.push(normalizeTarget(part));
    }
  }
  return [...new Set(targets)];
}

/** Choose a single consumer, for the receiving side. */
export async function pickReceivingTarget(config: LoadedConfig['config']): Promise<string | null> {
  const known = config.targets.length > 0 ? config.targets : SUGGESTED_TARGETS.slice(0, 6);
  const choices: Array<Choice<string | null>> = known.map((target) => ({
    value: target,
    label: target,
  }));
  choices.push({
    value: null,
    label: 'not sure — show me everything',
    hint: 'no narrowing',
  });

  const initial = config.defaultTarget ? known.indexOf(config.defaultTarget) : 0;
  return select<string | null>({
    message: 'Which consumer is this repository?',
    choices,
    initial: initial >= 0 ? initial : 0,
  });
}

export interface PickedHandoff {
  entry: StoredHandoff;
}

/** Choose a stored handoff, or return null when there are none. */
export async function pickHandoff(
  cwd: string,
  direction: Direction | 'all' = 'outgoing',
  message = 'Which handoff?',
): Promise<StoredHandoff | null> {
  const loaded = loadConfig(cwd);
  const store = new HandoffStore(handoffDirectory(loaded));
  const { handoffs } = store.list(direction);
  if (handoffs.length === 0) return null;

  const choices: Array<Choice<StoredHandoff>> = handoffs.map((entry) => {
    const fm = entry.handoff.frontmatter;
    const flags = [
      fm.targets.join(',') || 'any',
      fm.breaking ? 'breaking' : '',
      fm.status !== 'ready' ? fm.status : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return { value: entry, label: entry.handoff.title || entry.id, hint: flags };
  });

  return select<StoredHandoff>({ message, choices });
}

/** Choose a delivery channel, hiding any that cannot run on this machine. */
/**
 * Pick a channel, judged with this project's settings and led by its routes.
 *
 * Asking each channel whether it works with no settings at all hid every configured
 * webhook, and listing them in a fixed order hid the answer the project already gave for
 * this team. Routed channels come first; the rest follow; blocked ones are left out.
 */
export async function pickChannel(config: HandoffConfig, targets: readonly string[]): Promise<string> {
  const options = deliveryOptions(config, targets).filter(
    (option) => option.available && option.id !== 'stdout',
  );
  const choices: Array<Choice<string>> = options.map((option) => ({
    value: option.id,
    label: option.label ? `${option.id} → ${option.label}` : option.id,
    hint: [
      option.routed ? 'routed' : '',
      option.description.replace(/\.$/, ''),
      option.uploads ? `uploads ${option.uploads}` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  }));
  return select<string>({ message: 'Send it where?', choices });
}

/** A short line describing where a repository currently stands. */
export function describeRepo(loaded: LoadedConfig): string {
  return `${style.bold(loaded.config.project)} ${style.dim(loaded.root)}`;
}
