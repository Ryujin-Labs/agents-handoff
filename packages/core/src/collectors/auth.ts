import { pathsInCategory } from './classify.ts';
import { trulyAdded, trulyRemoved } from './diff.ts';
import { dedupe } from './api.ts';
import type { Collector, CollectorResult, Signal } from './types.ts';
import { emptyResult } from './types.ts';
import { truncate } from '../util/text.ts';

/**
 * Security-relevant edits get their own collector because they are the changes most likely
 * to break a client silently: a new guard does not change a route's shape, only who is
 * allowed through it.
 */
const PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /@Use(?:Guards|Interceptors)\s*\(\s*([\w,\s]+)\)/, label: 'guard applied' },
  { regex: /@(?:Roles|Permissions|Scopes|RequirePermission|Authorize)\s*\(\s*([^)]*)\)/, label: 'permission requirement' },
  { regex: /\b(?:requirePermission|checkPermission|hasPermission|can|authorize|ensureScope)\s*\(\s*['"]([^'"]+)/, label: 'permission check' },
  { regex: /\b(?:permission_required|login_required|requires_auth|Depends\s*\(\s*\w*[Aa]uth)/, label: 'auth dependency' },
  { regex: /\buse[A-Z]\w*Guard\b|\bAuthGuard\b|\bJwtGuard\b|\bpassport\.authenticate\b/, label: 'auth guard' },
  { regex: /\b(?:scopes?|roles?|permissions?)\s*[:=]\s*\[?\s*['"]([^'"]+)/, label: 'scope/role literal' },
  { regex: /\b(?:401|403)\b/, label: 'auth error code' },
  { regex: /\b(?:setCookie|httpOnly|sameSite|secure:\s*true|csrf|cors|Access-Control-Allow)/i, label: 'transport security' },
  { regex: /\b(?:expiresIn|refreshToken|accessToken|tokenRotation|rotateToken)\b/i, label: 'token lifetime' },
];

export const authCollector: Collector = {
  name: 'auth',
  description: 'Authentication guards, permissions, scopes and token handling.',
  collect(context): CollectorResult {
    // Scanned across every changed file, not only auth-named ones. A guard is applied in
    // the route file, a scope is checked in a service, a cookie flag is set in the server
    // bootstrap: restricting this collector to paths matching /auth/ would miss the places
    // authorization actually changes.
    const scanned = [...context.classification.keys()];
    if (scanned.length === 0) return emptyResult('auth');
    const paths = pathsInCategory(context.classification, 'auth');

    const signals: Signal[] = [];
    for (const file of context.diffFor(scanned)) {
      for (const line of trulyAdded(file)) {
        for (const { regex, label } of PATTERNS) {
          if (regex.test(line)) {
            signals.push({
              kind: 'auth',
              message: `${label} added`,
              file: file.path,
              evidence: truncate(line.trim(), 140),
            });
            break;
          }
        }
      }
      for (const line of trulyRemoved(file)) {
        for (const { regex, label } of PATTERNS) {
          if (regex.test(line)) {
            signals.push({
              kind: 'breaking-candidate',
              message: `${label} removed or changed`,
              file: file.path,
              evidence: truncate(line.trim(), 140),
            });
            break;
          }
        }
      }
    }

    const deduped = dedupe(signals);
    if (deduped.length === 0) return emptyResult('auth');

    const touched = [...new Set(deduped.map((signal) => signal.file).filter(Boolean))] as string[];
    return {
      name: 'auth',
      summary: `${deduped.length} authentication/authorization signal(s) across ${touched.length} file(s). Callers may start receiving 401/403 where they previously did not.`,
      signals: deduped,
      suggestedReading: [...new Set([...paths, ...touched])].slice(0, 10),
      facts: [],
    };
  },
};
