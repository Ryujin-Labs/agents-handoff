import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathsInCategory } from './classify.ts';
import type { Collector, CollectorResult } from './types.ts';
import { emptyResult } from './types.ts';

/**
 * Which test files moved, and how a receiver would run the suite.
 *
 * The command matters more than the file list: the `Verification` section of a handoff is
 * only useful if it names something the other developer can actually run.
 */
export const testCollector: Collector = {
  name: 'tests',
  description: 'Changed test files and the detected test command.',
  collect(context): CollectorResult {
    if (!context.config.includeTests) return emptyResult('tests');
    const paths = pathsInCategory(context.classification, 'test');
    const command = detectTestCommand(context.root);
    if (paths.length === 0 && !command) return emptyResult('tests');

    const facts: Array<{ label: string; value: string }> = [];
    if (command) facts.push({ label: 'test command', value: command });
    if (paths.length > 0) facts.push({ label: 'changed tests', value: paths.slice(0, 15).join('\n') });

    return {
      name: 'tests',
      summary:
        paths.length > 0
          ? `${paths.length} test file(s) changed. Their assertions are the most precise statement of the new behavior.`
          : 'No test files changed in this revision.',
      signals: [],
      suggestedReading: paths.slice(0, 8),
      facts,
    };
  },
};

/** Best-effort detection of the command that runs this project's tests. */
export function detectTestCommand(root: string): string | null {
  const packageJsonPath = join(root, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const scripts = parsed.scripts ?? {};
      for (const name of ['test', 'test:unit', 'tests', 'check']) {
        if (scripts[name]) return `npm run ${name}`;
      }
    } catch {
      // A malformed package.json is the project's problem, not ours.
    }
  }
  const candidates: Array<[string, string]> = [
    ['pyproject.toml', 'pytest'],
    ['pytest.ini', 'pytest'],
    ['tox.ini', 'pytest'],
    ['go.mod', 'go test ./...'],
    ['Cargo.toml', 'cargo test'],
    ['Gemfile', 'bundle exec rspec'],
    ['pubspec.yaml', 'flutter test'],
    ['Package.swift', 'swift test'],
    ['pom.xml', 'mvn test'],
    ['build.gradle', './gradlew test'],
    ['build.gradle.kts', './gradlew test'],
    ['Makefile', 'make test'],
  ];
  for (const [file, command] of candidates) {
    if (existsSync(join(root, file))) return command;
  }
  return null;
}
