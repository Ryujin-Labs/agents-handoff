/** A decoded keypress. `char` is set only for printable input. */
export interface Key {
  name:
    | 'up'
    | 'down'
    | 'left'
    | 'right'
    | 'enter'
    | 'space'
    | 'escape'
    | 'backspace'
    | 'tab'
    | 'home'
    | 'end'
    | 'abort'
    | 'eof'
    | 'char'
    | 'unknown';
  char?: string;
}

const ESC = '\u001b';

/**
 * Decode a terminal input chunk.
 *
 * Only the sequences the prompts actually use are recognized; anything else becomes
 * `unknown` and is ignored by the caller. Vim keys are accepted alongside the arrows
 * because a developer's hands are usually already there.
 */
export function decodeKey(sequence: string): Key {
  switch (sequence) {
    case `${ESC}[A`:
    case `${ESC}OA`:
      return { name: 'up' };
    case `${ESC}[B`:
    case `${ESC}OB`:
      return { name: 'down' };
    case `${ESC}[D`:
    case `${ESC}OD`:
      return { name: 'left' };
    case `${ESC}[C`:
    case `${ESC}OC`:
      return { name: 'right' };
    case `${ESC}[H`:
    case `${ESC}OH`:
      return { name: 'home' };
    case `${ESC}[F`:
    case `${ESC}OF`:
      return { name: 'end' };
    case '\r':
    case '\n':
      return { name: 'enter' };
    case ' ':
      return { name: 'space', char: ' ' };
    case '\t':
      return { name: 'tab' };
    case '\u0003':
      return { name: 'abort' };
    case '\u0004':
      return { name: 'eof' };
    case '\u007f':
    case '\b':
      return { name: 'backspace' };
    case ESC:
      return { name: 'escape' };
    default:
      break;
  }

  if (sequence.length === 1) {
    const code = sequence.codePointAt(0) ?? 0;
    // Control characters other than the ones handled above carry no meaning here.
    if (code < 32) return { name: 'unknown' };
    return { name: 'char', char: sequence };
  }
  return { name: 'unknown' };
}

/** Vim-style movement, applied only where a raw character is not being captured. */
export function movementFor(key: Key): 'up' | 'down' | null {
  if (key.name === 'up') return 'up';
  if (key.name === 'down') return 'down';
  if (key.name === 'char' && key.char === 'k') return 'up';
  if (key.name === 'char' && key.char === 'j') return 'down';
  return null;
}
