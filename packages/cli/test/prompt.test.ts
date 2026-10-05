import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { decodeKey, movementFor } from '../src/prompt/keys.ts';
import { ansi, fit } from '../src/prompt/render.ts';
import {
  confirm,
  multiselect,
  PromptCancelled,
  select,
  splitSequences,
  text,
  type PromptIO,
} from '../src/prompt/index.ts';

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const ENTER = '\r';
const SPACE = ' ';
const CTRL_C = '\u0003';
const BACKSPACE = '\u007f';

interface Harness {
  io: PromptIO;
  /** Everything the prompt wrote, with ANSI stripped. */
  output(): string;
  /** Everything the prompt wrote, escape sequences intact. */
  raw(): string;
}

function harness(): Harness {
  const input = new PassThrough() as PassThrough & { setRawMode?: (m: boolean) => void };
  input.setRawMode = () => {};
  let written = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      written += String(chunk);
      callback();
    },
  });
  return {
    io: { input, output, columns: 80 },
    output: () => written.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''),
    raw: () => written,
  };
}

/** Feed keys once the prompt has attached its listener. */
function drive(io: PromptIO, keys: string[]): void {
  let index = 0;
  const next = (): void => {
    if (index >= keys.length) return;
    (io.input as PassThrough).write(keys[index++]);
    setImmediate(next);
  };
  setImmediate(next);
}

describe('decodeKey', () => {
  it('recognizes arrows from both CSI and SS3 encodings', () => {
    assert.equal(decodeKey('\u001b[A').name, 'up');
    assert.equal(decodeKey('\u001bOA').name, 'up');
    assert.equal(decodeKey('\u001b[B').name, 'down');
  });

  it('recognizes enter, space, backspace and the abort keys', () => {
    assert.equal(decodeKey('\r').name, 'enter');
    assert.equal(decodeKey('\n').name, 'enter');
    assert.equal(decodeKey(' ').name, 'space');
    assert.equal(decodeKey('\u007f').name, 'backspace');
    assert.equal(decodeKey('\u0003').name, 'abort');
    assert.equal(decodeKey('\u0004').name, 'eof');
    assert.equal(decodeKey('\u001b').name, 'escape');
  });

  it('passes printable characters through', () => {
    assert.deepEqual(decodeKey('a'), { name: 'char', char: 'a' });
    assert.deepEqual(decodeKey('Ş'), { name: 'char', char: 'Ş' });
  });

  it('ignores control characters it does not handle', () => {
    assert.equal(decodeKey('\u0001').name, 'unknown');
  });
});

describe('movementFor', () => {
  it('accepts vim keys alongside the arrows', () => {
    assert.equal(movementFor({ name: 'char', char: 'j' }), 'down');
    assert.equal(movementFor({ name: 'char', char: 'k' }), 'up');
    assert.equal(movementFor({ name: 'char', char: 'x' }), null);
  });
});

describe('splitSequences', () => {
  it('keeps an escape sequence together', () => {
    assert.deepEqual(splitSequences('\u001b[A'), ['\u001b[A']);
  });

  it('splits a chunk carrying several keys', () => {
    assert.deepEqual(splitSequences('\u001b[B\u001b[B\r'), ['\u001b[B', '\u001b[B', '\r']);
  });

  it('treats a lone escape as its own key', () => {
    assert.deepEqual(splitSequences('\u001b'), ['\u001b']);
  });
});

describe('fit', () => {
  it('truncates with an ellipsis only when needed', () => {
    assert.equal(fit('short', 20), 'short');
    assert.equal(fit('abcdefghij', 5), 'abcd…');
  });
});

const CHOICES = [
  { value: 'mobile', label: 'mobile' },
  { value: 'web', label: 'web' },
  { value: 'devops', label: 'devops' },
];

describe('select', () => {
  it('returns the first choice on enter', async () => {
    const h = harness();
    drive(h.io, [ENTER]);
    assert.equal(await select({ message: 'Who?', choices: CHOICES, io: h.io }), 'mobile');
  });

  it('moves down and returns the highlighted choice', async () => {
    const h = harness();
    drive(h.io, [DOWN, DOWN, ENTER]);
    assert.equal(await select({ message: 'Who?', choices: CHOICES, io: h.io }), 'devops');
  });

  it('wraps around at both ends', async () => {
    const h = harness();
    drive(h.io, [UP, ENTER]);
    assert.equal(await select({ message: 'Who?', choices: CHOICES, io: h.io }), 'devops');
  });

  it('honours an initial index', async () => {
    const h = harness();
    drive(h.io, [ENTER]);
    assert.equal(
      await select({ message: 'Who?', choices: CHOICES, initial: 1, io: h.io }),
      'web',
    );
  });

  it('accepts vim keys', async () => {
    const h = harness();
    drive(h.io, ['j', ENTER]);
    assert.equal(await select({ message: 'Who?', choices: CHOICES, io: h.io }), 'web');
  });

  it('renders the message, every choice and a key hint', async () => {
    const h = harness();
    drive(h.io, [ENTER]);
    await select({ message: 'Who?', choices: CHOICES, io: h.io });
    const out = h.output();
    for (const label of ['Who?', 'mobile', 'web', 'devops']) assert.match(out, new RegExp(label));
    assert.match(out, /enter select/);
  });

  it('leaves a settled line showing the answer', async () => {
    const h = harness();
    drive(h.io, [DOWN, ENTER]);
    await select({ message: 'Who?', choices: CHOICES, io: h.io });
    assert.match(h.output(), /✓ Who\? web/);
  });

  it('throws PromptCancelled on ctrl+c', async () => {
    const h = harness();
    drive(h.io, [CTRL_C]);
    await assert.rejects(
      select({ message: 'Who?', choices: CHOICES, io: h.io }),
      (error: Error) => error instanceof PromptCancelled,
    );
  });

  it('restores the cursor even when cancelled', async () => {
    const h = harness();
    drive(h.io, [CTRL_C]);
    await select({ message: 'Who?', choices: CHOICES, io: h.io }).catch(() => {});
    // A prompt that exits leaving the cursor hidden ruins the terminal it was run in.
    assert.ok(h.raw().includes(ansi.showCursor), 'cursor was never restored');
  });

  it('refuses to open with no choices', async () => {
    const h = harness();
    await assert.rejects(select({ message: 'Who?', choices: [], io: h.io }), /no choices/);
  });
});

describe('multiselect', () => {
  it('returns nothing when enter is pressed immediately', async () => {
    const h = harness();
    drive(h.io, [ENTER]);
    assert.deepEqual(await multiselect({ message: 'Who?', choices: CHOICES, io: h.io }), []);
  });

  it('toggles with space and keeps document order in the render', async () => {
    const h = harness();
    drive(h.io, [SPACE, DOWN, SPACE, ENTER]);
    assert.deepEqual(
      await multiselect({ message: 'Who?', choices: CHOICES, io: h.io }),
      ['mobile', 'web'],
    );
  });

  it('untoggles a choice pressed twice', async () => {
    const h = harness();
    drive(h.io, [SPACE, SPACE, DOWN, SPACE, ENTER]);
    assert.deepEqual(await multiselect({ message: 'Who?', choices: CHOICES, io: h.io }), ['web']);
  });

  it('starts from the initial selection', async () => {
    const h = harness();
    drive(h.io, [ENTER]);
    assert.deepEqual(
      await multiselect({ message: 'Who?', choices: CHOICES, initial: ['devops'], io: h.io }),
      ['devops'],
    );
  });

  it('refuses an empty selection when required, then accepts one', async () => {
    const h = harness();
    drive(h.io, [ENTER, SPACE, ENTER]);
    const chosen = await multiselect({
      message: 'Who?',
      choices: CHOICES,
      required: true,
      io: h.io,
    });
    assert.deepEqual(chosen, ['mobile']);
    assert.match(h.output(), /pick at least one/);
  });

  it('cancels on ctrl+c', async () => {
    const h = harness();
    drive(h.io, [CTRL_C]);
    await assert.rejects(multiselect({ message: 'Who?', choices: CHOICES, io: h.io }), PromptCancelled);
  });
});

describe('text', () => {
  it('collects typed characters', async () => {
    const h = harness();
    drive(h.io, ['a', 'u', 't', 'h', ENTER]);
    assert.equal(await text({ message: 'Title?', io: h.io }), 'auth');
  });

  it('accepts spaces as part of the value', async () => {
    const h = harness();
    drive(h.io, ['a', SPACE, 'b', ENTER]);
    assert.equal(await text({ message: 'Title?', io: h.io }), 'a b');
  });

  it('deletes with backspace', async () => {
    const h = harness();
    drive(h.io, ['a', 'b', 'c', BACKSPACE, ENTER]);
    assert.equal(await text({ message: 'Title?', io: h.io }), 'ab');
  });

  it('falls back to the default on an empty answer', async () => {
    const h = harness();
    drive(h.io, [ENTER]);
    assert.equal(await text({ message: 'Title?', default: 'Untitled', io: h.io }), 'Untitled');
  });

  it('re-asks while validation fails', async () => {
    const h = harness();
    drive(h.io, [ENTER, 'o', 'k', ENTER]);
    const value = await text({
      message: 'Title?',
      validate: (v) => (v ? null : 'required'),
      io: h.io,
    });
    assert.equal(value, 'ok');
    assert.match(h.output(), /required/);
  });

  it('handles non-ASCII input', async () => {
    const h = harness();
    drive(h.io, ['ş', 'a', ENTER]);
    assert.equal(await text({ message: 'Title?', io: h.io }), 'şa');
  });

  it('cancels on ctrl+c', async () => {
    const h = harness();
    drive(h.io, [CTRL_C]);
    await assert.rejects(text({ message: 'Title?', io: h.io }), PromptCancelled);
  });
});

describe('confirm', () => {
  it('defaults to yes', async () => {
    const h = harness();
    drive(h.io, [ENTER]);
    assert.equal(await confirm({ message: 'Install?', io: h.io }), true);
  });

  it('defaults to no when told to', async () => {
    const h = harness();
    drive(h.io, [ENTER]);
    assert.equal(await confirm({ message: 'Install?', default: false, io: h.io }), false);
  });

  it('moves to the other answer', async () => {
    const h = harness();
    drive(h.io, [DOWN, ENTER]);
    assert.equal(await confirm({ message: 'Install?', io: h.io }), false);
  });
});
