/**
 * Categories a changed file can belong to. A file may belong to several: a NestJS
 * controller is both `api` and, if it touches a guard, `auth`.
 */
export type FileCategory =
  | 'api'
  | 'auth'
  | 'contract'
  | 'database'
  | 'config'
  | 'environment'
  | 'dependency'
  | 'infrastructure'
  | 'test'
  | 'ui'
  | 'docs'
  | 'generated'
  | 'source';

interface Rule {
  category: FileCategory;
  pattern: RegExp;
}

/**
 * Path-based classification rules, ordered from most to least specific.
 *
 * These are heuristics, and they are deliberately shallow: their job is to decide which
 * small slice of the diff is worth reading, not to be correct about every repository
 * layout in existence. Everything downstream treats the result as a hint.
 */
const RULES: Rule[] = [
  // API surface
  { category: 'api', pattern: /(^|\/)(routes?|controllers?|endpoints?|handlers?|resolvers?)\// },
  { category: 'api', pattern: /\.(controller|route|routes|router|handler|resolver|endpoint)\.[jt]sx?$/ },
  { category: 'api', pattern: /(^|\/)api\// },
  { category: 'api', pattern: /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i },
  { category: 'api', pattern: /\.(graphql|graphqls|gql|proto)$/ },
  { category: 'api', pattern: /(^|\/)app\/api\/.*\/route\.[jt]s$/ },
  { category: 'api', pattern: /(^|\/)pages\/api\// },
  { category: 'api', pattern: /urls?\.py$/ },

  // Authentication and authorization
  { category: 'auth', pattern: /(^|\/)(auth|authn|authz|permissions?|policies|guards?|rbac)(\/|\.|-|_)/i },
  { category: 'auth', pattern: /\.(guard|policy|permission|strategy)\.[jt]sx?$/ },
  { category: 'auth', pattern: /(^|\/)middlewares?\// },
  { category: 'auth', pattern: /(jwt|oauth|session|token|login|signin|password|credential)/i },

  // Contracts and types
  { category: 'contract', pattern: /\.d\.ts$/ },
  { category: 'contract', pattern: /(^|\/)(types?|models?|schemas?|dto|dtos|entities|interfaces?)\// },
  { category: 'contract', pattern: /\.(types?|model|schema|dto|entity|interface)\.[jt]sx?$/ },
  { category: 'contract', pattern: /(^|\/)(openapi|schema)[^/]*\.(ya?ml|json)$/i },

  // Database
  { category: 'database', pattern: /(^|\/)(migrations?|migrate)\// },
  { category: 'database', pattern: /(^|\/)(db|database)\// },
  { category: 'database', pattern: /(^|\/)alembic\/versions\// },
  { category: 'database', pattern: /schema\.(prisma|rb|sql)$/ },
  { category: 'database', pattern: /\.sql$/ },

  // Environment
  { category: 'environment', pattern: /(^|\/)\.env(\.|$)/ },
  { category: 'environment', pattern: /(^|\/)env(ironment)?\.[jt]s$/ },

  // Dependencies
  { category: 'dependency', pattern: /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/ },
  { category: 'dependency', pattern: /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?)$/ },
  { category: 'dependency', pattern: /(^|\/)(go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|Gemfile(\.lock)?|composer\.(json|lock)|pubspec\.(yaml|lock)|Podfile(\.lock)?)$/ },
  { category: 'dependency', pattern: /(^|\/)build\.gradle(\.kts)?$/ },

  // Infrastructure
  { category: 'infrastructure', pattern: /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml)$/ },
  { category: 'infrastructure', pattern: /(^|\/)(k8s|kubernetes|helm|charts|terraform|infra|deploy)\// },
  { category: 'infrastructure', pattern: /\.(tf|tfvars)$/ },
  { category: 'infrastructure', pattern: /(^|\/)\.github\/workflows\// },
  { category: 'infrastructure', pattern: /(^|\/)(vercel|netlify|fly|railway|serverless)\.(json|toml|ya?ml)$/ },

  // Tests
  { category: 'test', pattern: /\.(test|spec)\.[jt]sx?$/ },
  { category: 'test', pattern: /(^|\/)(tests?|__tests__|spec|e2e|cypress|playwright)\// },
  { category: 'test', pattern: /_test\.(go|py|rb)$/ },
  { category: 'test', pattern: /(^|\/)test_[^/]+\.py$/ },
  { category: 'test', pattern: /Tests?\.(java|kt|swift|cs)$/ },

  // Config
  { category: 'config', pattern: /(^|\/)config(uration)?(\/|\.)/ },
  { category: 'config', pattern: /\.config\.[cm]?[jt]s$/ },
  { category: 'config', pattern: /(^|\/)(tsconfig|jsconfig)[^/]*\.json$/ },

  // UI
  { category: 'ui', pattern: /\.(tsx|jsx|vue|svelte)$/ },
  { category: 'ui', pattern: /(^|\/)(components?|screens?|views?|pages?|widgets?)\// },
  { category: 'ui', pattern: /\.(css|scss|less)$/ },

  // Docs
  { category: 'docs', pattern: /\.(md|mdx|rst|adoc)$/ },
  { category: 'docs', pattern: /(^|\/)docs?\// },

  // Generated output, which should never drive a handoff
  { category: 'generated', pattern: /(^|\/)(dist|build|out|coverage|node_modules|vendor|\.next|target)\// },
  { category: 'generated', pattern: /\.(min\.js|map|lock)$/ },
  { category: 'generated', pattern: /\.(pb|generated|gen)\.[a-z]+$/ },
  { category: 'generated', pattern: /(^|\/)__generated__\// },
];

/** Categories for one path. Always includes `source` for non-generated code files. */
export function classifyPath(path: string): FileCategory[] {
  const categories = new Set<FileCategory>();
  for (const rule of RULES) {
    if (rule.pattern.test(path)) categories.add(rule.category);
  }
  if (categories.has('generated')) return ['generated'];
  if (categories.size === 0) categories.add('source');
  return [...categories];
}

/** True when a path should be excluded from analysis entirely. */
export function isNoise(path: string): boolean {
  return classifyPath(path).includes('generated');
}

export type Classification = Map<string, FileCategory[]>;

export function classifyAll(paths: readonly string[]): Classification {
  return new Map(paths.map((path) => [path, classifyPath(path)]));
}

export function pathsInCategory(classification: Classification, category: FileCategory): string[] {
  const result: string[] = [];
  for (const [path, categories] of classification) {
    if (categories.includes(category)) result.push(path);
  }
  return result;
}
