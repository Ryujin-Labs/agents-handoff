// Where the two sites live. Both read this file, so a link from one to the other is
// always right.
//
// Build with SITE_DOMAIN set to the domain you own — `SITE_DOMAIN=example.dev npm run build`
// — and the landing page is served from https://example.dev, the docs from
// https://docs.example.dev. Without it, both point at their local dev servers.
const domain = process.env.SITE_DOMAIN?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');

export const SITE_URL = domain ? `https://${domain}` : 'http://localhost:4321';
export const DOCS_URL = domain ? `https://docs.${domain}` : 'http://localhost:4322';
export const REPO_URL = 'https://github.com/Ryujin-Labs/agents-handoff';
