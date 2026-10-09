import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { DOCS_URL, REPO_URL, SITE_URL } from '../site.config.mjs';

export default defineConfig({
  site: DOCS_URL,
  devToolbar: { enabled: false },
  server: { port: 4322 },
  integrations: [
    starlight({
      title: 'Agents Handoff',
      description:
        'Docs for Agents Handoff: an open Markdown format and a local toolkit for explaining a finished change to the next team’s coding agent.',
      logo: { src: './src/assets/logo.svg' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: REPO_URL }],
      customCss: ['./src/styles/theme.css'],
      // Pages are generated from the repository's Markdown (scripts/sync-docs.mjs), and
      // each one sets its own edit link to its source file.
      editLink: { baseUrl: `${REPO_URL}/edit/main/` },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Introduction', slug: 'index' },
            { slug: 'getting-started' },
            { slug: 'guides/the-loop' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { slug: 'guides/writing-good-handoffs' },
            { slug: 'guides/export' },
            { slug: 'guides/configuration' },
          ],
        },
        {
          label: 'Use it with',
          items: [
            { slug: 'integrations/claude-code' },
            { slug: 'integrations/codex' },
            { slug: 'integrations/mcp' },
            { slug: 'integrations/cli' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { slug: 'reference/spec' },
            { slug: 'reference/architecture' },
            { slug: 'reference/security' },
            { slug: 'reference/limitations' },
          ],
        },
        {
          label: 'Project',
          items: [
            { slug: 'project/changelog' },
            { slug: 'project/contributing' },
            { label: 'Website', link: SITE_URL },
          ],
        },
      ],
    }),
  ],
});
