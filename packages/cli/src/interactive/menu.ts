import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILENAME, Git, handoffDirectory, HandoffStore, loadConfig, VERSION } from 'agents-handoff-core';
import { select, type Choice } from '../prompt/index.ts';
import { out, style } from '../ui.ts';
import { configCommand } from '../commands/config.ts';
import { listCommand, showCommand, validateCommand } from '../commands/inspect.ts';
import { interactiveCreate } from './create.ts';
import { interactiveInit } from './setup.ts';
import { interactiveReceive, interactiveSend } from './transfer.ts';
import { pickHandoff } from './pick.ts';

type Action = 'create' | 'receive' | 'list' | 'show' | 'validate' | 'send' | 'init' | 'config' | 'quit';

/**
 * The bare `handoff` command on a terminal.
 *
 * Ordered by what a developer is most likely to be here for, and filtered by what this
 * repository can currently do — offering "send a handoff" in a directory with none is a
 * dead end dressed up as a choice.
 */
export async function mainMenu(cwd: string): Promise<number> {
  const loaded = loadConfig(cwd);
  const store = new HandoffStore(handoffDirectory(loaded));
  const git = new Git(cwd);
  const initialized = existsSync(join(loaded.root, CONFIG_FILENAME));
  const outgoing = store.list('outgoing').handoffs.length;
  const inbox = store.list('inbox').handoffs.length;

  out();
  out(`${style.bold('handoff')} ${style.dim(VERSION)}  ${style.dim(loaded.root)}`);
  if (!initialized) {
    out(style.dim('This project is not set up yet — everything still works on defaults.'));
  }
  out();

  const choices: Array<Choice<Action>> = [];

  if (git.isRepo()) {
    choices.push({
      value: 'create',
      label: 'Write a handoff',
      hint: 'describe a change for another team',
    });
  }
  choices.push({
    value: 'receive',
    label: 'Read one someone sent me',
    hint: inbox > 0 ? `${inbox} in the inbox` : 'from a file',
  });
  if (outgoing + inbox > 0) {
    choices.push({ value: 'list', label: 'List handoffs', hint: `${outgoing + inbox} here` });
    choices.push({ value: 'show', label: 'Read one of mine' });
    choices.push({ value: 'validate', label: 'Check one against the schema' });
    choices.push({ value: 'send', label: 'Send one' });
  }
  choices.push({
    value: 'init',
    label: initialized ? 'Change project settings' : 'Set this project up',
    hint: initialized ? undefined : 'writes handoff.config.json',
  } as Choice<Action>);
  if (initialized) choices.push({ value: 'config', label: 'Show settings' });
  choices.push({ value: 'quit', label: 'Quit' });

  const action = await select<Action>({ message: 'What do you want to do?', choices });

  switch (action) {
    case 'create':
      return interactiveCreate(cwd);
    case 'receive':
      return interactiveReceive(cwd);
    case 'send':
      return interactiveSend(cwd);
    case 'init':
      return interactiveInit(cwd);
    case 'list':
      return listCommand({ values: { all: true }, positionals: [] }, cwd);
    case 'config':
      return configCommand({ values: {}, positionals: [] }, cwd);
    case 'show': {
      const entry = await pickHandoff(cwd, 'all', 'Which one?');
      return entry ? showCommand({ values: {}, positionals: [entry.id] }, cwd) : 0;
    }
    case 'validate': {
      const entry = await pickHandoff(cwd, 'all', 'Which one?');
      return entry ? validateCommand({ values: {}, positionals: [entry.id] }, cwd) : 0;
    }
    case 'quit':
    default:
      return 0;
  }
}
