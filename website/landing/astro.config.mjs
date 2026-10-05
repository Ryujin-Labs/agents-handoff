import { defineConfig } from 'astro/config';
import { SITE_URL } from '../site.config.mjs';

export default defineConfig({
  site: SITE_URL,
  devToolbar: { enabled: false },
  server: { port: 4321 },
});
