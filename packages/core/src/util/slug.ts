const MAX_SLUG_LENGTH = 60;

/**
 * Turn arbitrary text into a stable, filesystem- and URL-safe slug.
 * Deterministic: the same input always produces the same output.
 */
export function slugify(input: string, maxLength = MAX_SLUG_LENGTH): string {
  const full = input
    .normalize('NFKD')
    // Strip combining marks so "réf" -> "ref" rather than "rf".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (full.length <= maxLength) return full || 'handoff';
  // Cut at a word boundary: the id becomes a directory and an attachment name, and
  // `…-renamed-dele` reads as a typo. A single overlong word is cut where it must be.
  const cut = full.slice(0, maxLength + 1);
  const boundary = cut.lastIndexOf('-');
  const slug = (boundary > 0 ? cut.slice(0, boundary) : full.slice(0, maxLength)).replace(/-+$/g, '');
  return slug || 'handoff';
}

/** `YYYY-MM-DD` in UTC. */
export function datePrefix(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Build the conventional `YYYY-MM-DD-<slug>` handoff id. */
export function buildHandoffId(title: string, date: Date): string {
  return `${datePrefix(date)}-${slugify(title)}`;
}

/**
 * Append `-2`, `-3`, ... until `isTaken` returns false. Used so two handoffs created on
 * the same day with the same title do not collide.
 */
export function uniqueId(base: string, isTaken: (id: string) => boolean): string {
  if (!isTaken(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error(`Could not find a free handoff id based on "${base}"`);
}
