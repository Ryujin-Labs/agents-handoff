#!/usr/bin/env node
/**
 * Build the docs pages from the Markdown that already lives in the repository.
 *
 * The README, SPEC.md and docs/*.md are what GitHub shows and what contributors edit. A
 * second copy written for the website would drift from them within a release, so the site
 * is generated from them instead: whole files, or single `##` sections of the README, with
 * Starlight frontmatter added and repository-relative links turned into site links (or into
 * GitHub links, for files the site does not carry).
 *
 * The generated pages are gitignored. Edit the sources, not the output.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_URL } from '../../site.config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const contentDir = resolve(here, '..', 'src', 'content', 'docs');

/**
 * Every generated page. `sources` are concatenated in order: the first gives the page its
 * body; any later one keeps its own heading, so it reads as a section of the page.
 */
const PAGES = [
  {
    slug: 'getting-started',
    title: 'Quick start',
    description: 'Install Agents Handoff in Claude Code, Codex, any MCP client, or as a CLI.',
    sources: [{ file: 'README.md', section: 'Quick start' }],
  },
  {
    slug: 'guides/the-loop',
    title: 'How it works',
    description: 'From a finished change to the other team’s agent, step by step.',
    sources: [
      { file: 'README.md', section: 'The loop' },
      { file: 'README.md', section: 'What a handoff looks like' },
      { file: 'README.md', section: 'What your agent gets' },
    ],
  },
  {
    slug: 'guides/writing-good-handoffs',
    description: 'What a handoff is for, and how to write one another team can act on.',
    sources: [{ file: 'docs/writing-good-handoffs.md' }],
  },
  {
    slug: 'guides/export',
    title: 'Export a Markdown file',
    description: 'Export a validated HANDOFF.md for another team to read and consume.',
    sources: [{ file: 'README.md', section: 'Export' }],
  },
  {
    slug: 'guides/configuration',
    title: 'Configuration',
    description: 'handoff.config.json: targets, language, and consuming-team context.',
    sources: [{ file: 'README.md', section: 'Configuration' }],
  },
  {
    slug: 'integrations/claude-code',
    title: 'Claude Code',
    description: 'The Claude Code plugin: two skills and the handoff MCP tools.',
    sources: [{ file: 'docs/claude-code.md' }],
  },
  {
    slug: 'integrations/codex',
    title: 'Codex',
    description: 'The Codex plugin: the same skills and MCP tools, packaged for Codex.',
    sources: [{ file: 'packages/integrations/codex/README.md' }],
  },
  {
    slug: 'integrations/mcp',
    title: 'MCP server',
    description: 'The handoff tools and prompts over MCP, for any client.',
    sources: [{ file: 'docs/mcp.md' }],
  },
  {
    slug: 'integrations/cli',
    title: 'CLI',
    description: 'The handoff command: every subcommand, flag and exit code.',
    sources: [{ file: 'docs/cli.md' }],
  },
  {
    slug: 'reference/spec',
    title: 'HANDOFF.md specification',
    description: 'The HANDOFF.md v1 format: frontmatter, sections, and conformance.',
    sources: [{ file: 'SPEC.md' }],
  },
  {
    slug: 'reference/architecture',
    title: 'Architecture',
    description: 'How the core, the MCP server, the CLI and the plugins fit together.',
    sources: [{ file: 'docs/architecture.md' }],
  },
  {
    slug: 'reference/security',
    title: 'Security',
    description: 'How handoffs from other teams are handled, and how to report a vulnerability.',
    sources: [
      { file: 'README.md', section: 'Security' },
      { file: 'SECURITY.md' },
    ],
  },
  {
    slug: 'reference/limitations',
    title: 'Limitations',
    description: 'What this release does not do yet.',
    sources: [{ file: 'README.md', section: 'Limitations' }],
  },
  {
    slug: 'project/changelog',
    title: 'Changelog',
    description: 'Every release of Agents Handoff.',
    sources: [{ file: 'CHANGELOG.md' }],
  },
  {
    slug: 'project/contributing',
    title: 'Contributing',
    description: 'Building, testing and changing Agents Handoff.',
    sources: [{ file: 'CONTRIBUTING.md' }],
  },
];

/* ------------------------------------------------------------------------------- */

const FENCE = /^\s*(`{3,}|~{3,})/;

/** Split Markdown into lines, marking which ones are inside a fenced code block. */
function scan(markdown) {
  let fence = null;
  return markdown.split('\n').map((text) => {
    const match = FENCE.exec(text);
    const inFence = fence !== null;
    if (match) {
      const marker = match[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return { text, inFence: true };
    }
    return { text, inFence };
  });
}

/** The lines of one `## heading` section, without the heading, up to the next `##`. */
function sectionOf(markdown, heading, file) {
  const lines = scan(markdown);
  const start = lines.findIndex((line) => !line.inFence && line.text.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`${file} has no "## ${heading}" section`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.inFence && /^#{1,2}\s/.test(line.text)) {
      end = i;
      break;
    }
  }
  // A horizontal rule that only separated README sections is noise on its own page.
  const body = lines.slice(start + 1, end).map((line) => line.text);
  while (body.length && /^(\s*|---)$/.test(body[body.length - 1])) body.pop();
  return body.join('\n');
}

/** Raise every heading outside code fences by `by` levels, never above `##`. */
function shiftHeadings(markdown, by) {
  return scan(markdown)
    .map(({ text, inFence }) => {
      if (inFence) return text;
      const match = /^(#{2,6})(\s.*)$/.exec(text);
      if (!match) return text;
      return `${'#'.repeat(Math.max(2, match[1].length - by))}${match[2]}`;
    })
    .join('\n');
}

/** A whole file: its `# Title` becomes the page title, the rest the body. */
function wholeFile(markdown) {
  const lines = markdown.split('\n');
  const index = lines.findIndex((line) => /^#\s/.test(line));
  if (index < 0) return { title: null, body: markdown };
  return {
    title: lines[index].replace(/^#\s+/, '').trim(),
    body: lines.slice(index + 1).join('\n').replace(/^\s+/, ''),
  };
}

/* ------------------------------------------------------------------------------- */

/** Which page carries a whole file, and which page carries a README section. */
const fileToSlug = new Map();
const sectionToSlug = new Map();
for (const page of PAGES) {
  for (const source of page.sources) {
    if (source.section) sectionToSlug.set(`${source.file}#${githubAnchor(source.section)}`, page.slug);
    else if (!fileToSlug.has(source.file)) fileToSlug.set(source.file, page.slug);
  }
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens. */
function githubAnchor(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * Turn a repository-relative link into one that works on the site: a page the site has,
 * or the file on GitHub when it does not.
 */
function rewriteLink(target, fromFile) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/')) return target;
  const [path, anchor = ''] = target.split('#');
  const repoPath = posix.normalize(posix.join(posix.dirname(fromFile), path)).replace(/^\.\//, '');
  const hash = anchor ? `#${anchor}` : '';

  const section = anchor ? sectionToSlug.get(`${repoPath}#${anchor}`) : undefined;
  if (section) return `/${section}/`;
  const slug = fileToSlug.get(repoPath);
  if (slug) return `/${slug}/${hash}`;
  if (repoPath === 'README.md') return `/${hash}`;

  const kind = path.endsWith('/') ? 'tree' : 'blob';
  return `${REPO_URL}/${kind}/main/${repoPath.replace(/\/$/, '')}${hash}`;
}

/** Rewrite inline links outside code fences and inline code. */
function rewriteLinks(markdown, fromFile) {
  return scan(markdown)
    .map(({ text, inFence }) => {
      if (inFence) return text;
      // Split around inline code spans so a link-shaped string inside backticks is left alone.
      return text
        .split(/(`[^`]*`)/)
        .map((part) =>
          part.startsWith('`')
            ? part
            : part.replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (_, link, title = '') => `](${rewriteLink(link, fromFile)}${title})`),
        )
        .join('');
    })
    .join('\n');
}

function yamlString(value) {
  return JSON.stringify(value);
}

function build(page) {
  const parts = [];
  let title = page.title ?? null;
  for (const [index, source] of page.sources.entries()) {
    const markdown = readFileSync(join(repoRoot, source.file), 'utf8');
    let body;
    if (source.section) {
      const section = sectionOf(markdown, source.section, source.file);
      // The first section is the page; a later one is a section of it and keeps its heading.
      body = index === 0 ? shiftHeadings(section, 1) : `## ${source.section}\n\n${section}`;
    } else {
      const file = wholeFile(markdown);
      title ??= file.title;
      body = file.body;
    }
    parts.push(rewriteLinks(body.trim(), source.file));
  }

  const first = page.sources[0].file;
  const frontmatter = [
    '---',
    `title: ${yamlString(title ?? page.slug)}`,
    `description: ${yamlString(page.description)}`,
    `editUrl: ${yamlString(`${REPO_URL}/edit/main/${first}`)}`,
    '---',
  ].join('\n');
  const notice = `<!-- Generated from ${page.sources.map((source) => source.file + (source.section ? ` § ${source.section}` : '')).join(', ')} by website/docs/scripts/sync-docs.mjs. Edit the source, not this file. -->`;
  return `${frontmatter}\n\n${notice}\n\n${parts.join('\n\n')}\n`;
}

/* ------------------------------------------------------------------------------- */

// Start from a clean slate so a page removed from PAGES does not linger. Every generated
// section directory is wholly generated; hand-written pages (index.mdx) sit at the top level.
const generatedDirectories = new Set(
  PAGES.filter((page) => page.slug.includes('/')).map((page) => page.slug.split('/')[0]),
);
for (const directory of generatedDirectories) rmSync(join(contentDir, directory), { recursive: true, force: true });

for (const page of PAGES) {
  const out = join(contentDir, `${page.slug}.md`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, build(page), 'utf8');
}

console.log(`synced ${PAGES.length} pages from the repository into ${relative(process.cwd(), contentDir) || '.'}`);
