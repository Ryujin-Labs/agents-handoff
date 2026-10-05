import type { HandoffFrontmatter } from '../types.ts';

/**
 * The required frontmatter keys whose value the parser normalizes into a usable shape.
 *
 * Normalizing is what makes the rest of the toolchain simple, and it is also what erases
 * the difference between a key that was absent and a key that was written wrong. Both of
 * those have to reach the validator intact, so the uncoerced value travels alongside the
 * normalized one in `frontmatter.declared`, and these helpers are the only interpretation
 * of it — the parser, the serializer and the validator must not disagree about what
 * "well formed" means.
 */
export const COERCED_KEYS = ['breaking', 'targets', 'change_type'] as const;

export type CoercedKey = (typeof COERCED_KEYS)[number];

/** Whether the value a document declared for `key` is readable as the type the spec requires. */
export function isWellFormed(key: CoercedKey, value: unknown): boolean {
  // `breaking` is the one bit the protocol exists to carry, and it has no safe default:
  // YAML 1.2 reads `yes`, `"true"` and `1` as a string or a number, none of which is a
  // decision anybody made. Only a real boolean counts.
  if (key === 'breaking') return typeof value === 'boolean';
  return isStringList(value);
}

/**
 * A list of consumer labels or change types. The scalar shorthand (`targets: mobile`) is
 * accepted because the parser accepts it, and a valueless `targets:` reads as the empty
 * list it plainly means — unlike `breaking`, an empty list is a meaning the spec defines.
 */
function isStringList(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry)),
  );
}

/**
 * How a coerced key must be written back out.
 *
 * A value the parser could not read is written exactly as it arrived: rewriting
 * `breaking: yes` into `breaking: false` would put a decision in the file that nobody made,
 * and the validator's rejection would be the only trace that anything had been wrong. A key
 * the document never wrote stays unwritten for the same reason.
 */
export function declaredValue<T>(
  frontmatter: HandoffFrontmatter,
  key: CoercedKey,
  coerced: T,
): unknown {
  const declared = frontmatter.declared;
  // No source text to be faithful to: this handoff was built in memory, so its typed
  // fields are the only truth there is.
  if (declared === undefined) return coerced;
  if (!Object.hasOwn(declared, key)) return undefined;
  return isWellFormed(key, declared[key]) ? coerced : declared[key];
}
