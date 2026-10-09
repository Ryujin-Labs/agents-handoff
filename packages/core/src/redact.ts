export interface SecretFinding {
  /** Human label for what was matched, e.g. "AWS access key id". */
  kind: string;
  /** 1-based line number in the scanned text. */
  line: number;
  /** The matched text, masked. */
  preview: string;
}

interface SecretPattern {
  kind: string;
  /** Always global: every occurrence on a line is examined, not only the first. */
  regex: RegExp;
  /**
   * The capture group holding the secret itself. The placeholder test runs on it alone —
   * run on the whole match, a key named `SAMPLE_RATE_TOKEN` hid a real value.
   */
  value?: number;
  /** A further test the value must pass to count, for shapes that also occur in prose. */
  check?: (value: string) => boolean;
}

/**
 * Whether a bare value looks like a credential rather than a word.
 *
 * Unquoted assignments are everywhere in handoffs — `AUTH_TOKEN_STORAGE=keychain`,
 * `ACCESS_TOKEN_TTL=15minutes` — and a false positive blocks an export outright, so a bare
 * value has to look generated: several character classes, and some length.
 */
function looksGenerated(value: string): boolean {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((c) => c.test(value)).length;
  return (
    (classes === 4 && value.length >= 8) ||
    (classes >= 3 && value.length >= 10) ||
    (classes >= 2 && value.length >= 24)
  );
}

const SECRET_WORDS =
  'password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key';

/**
 * Patterns for credentials that should never leave a machine inside a handoff.
 *
 * This is a safety net, not a security control. A handoff is written by an agent that was
 * told to describe a change, so a leaked key here is an accident rather than an attack —
 * catching the common accidental shapes is worth far more than exhaustive coverage.
 */
const PATTERNS: SecretPattern[] = [
  {
    kind: 'private key block',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { kind: 'AWS access key id', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'GitHub fine-grained token', regex: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { kind: 'GitLab token', regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'npm token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'Slack token', regex: /\bx(?:ox[abeprs]|app)-[A-Za-z0-9-]{10,}\b/g },
  {
    kind: 'Slack webhook',
    regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/([A-Za-z0-9]{8,})/g,
    value: 1,
  },
  {
    kind: 'Discord webhook',
    regex: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/([A-Za-z0-9_-]{20,})/g,
    value: 1,
  },
  { kind: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'Stripe secret key', regex: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { kind: 'Stripe webhook secret', regex: /\bwhsec_[A-Za-z0-9]{16,}\b/g },
  { kind: 'Anthropic key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'OpenAI-style key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'JSON web token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    kind: 'bearer credential',
    regex: /\b[Aa]uthorization\s*[:=]\s*["']?Bearer\s+([A-Za-z0-9._-]{20,})/g,
    value: 1,
  },
  // Quoted, in any syntax: `password: "…"`, `"client_secret": "…"`, `DB_PASSWORD='…'`.
  {
    kind: 'assigned secret',
    regex: new RegExp(`\\b\\w*(?:${SECRET_WORDS})\\w*["']?\\s*[:=]\\s*["']([^"'\\s]{8,})["']`, 'gi'),
    value: 1,
  },
  // Unquoted, as in `.env`, YAML and INI files, and a bare `token` key in any syntax. Only
  // values that look generated count.
  {
    kind: 'assigned secret',
    regex: new RegExp(`\\b\\w*(?:${SECRET_WORDS}|token)\\w*["']?\\s*[:=]\\s*["']?([^\\s"'\`,;|<>]{8,})`, 'gi'),
    value: 1,
    check: looksGenerated,
  },
  {
    kind: 'connection string with password',
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]{4,})@/gi,
    value: 1,
  },
];

/** Values that match a secret shape but are obviously placeholders. */
const PLACEHOLDER = /(?:x{6,}|\*{4,}|\.{3,}|<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}\}|example|placeholder|redacted|your[_-]?\w*|change[_-]?me|dummy|sample|test[_-]?key)/i;

/** Scan text for credential-shaped strings. */
export function findSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    // One finding per kind per line is plenty to act on; overlapping matches of different
    // patterns (an Anthropic key is also OpenAI-shaped) are the same secret.
    const kinds = new Set<string>();
    const spans: Array<[number, number]> = [];
    for (const pattern of PATTERNS) {
      if (kinds.has(pattern.kind)) continue;
      for (const match of line.matchAll(pattern.regex)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if (spans.some(([from, to]) => start < to && end > from)) continue;
        const value = pattern.value === undefined ? match[0] : (match[pattern.value] ?? '');
        if (PLACEHOLDER.test(value)) continue;
        if (pattern.check && !pattern.check(value)) continue;
        spans.push([start, end]);
        kinds.add(pattern.kind);
        findings.push({ kind: pattern.kind, line: index + 1, preview: mask(match[0]) });
        break;
      }
    }
  }
  return findings;
}

/** Keep enough of a value to recognize it, hide enough to make it useless. */
export function mask(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 12) return `${trimmed.slice(0, 2)}***`;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-2)} (${trimmed.length} chars)`;
}
