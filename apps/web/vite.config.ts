import { execSync } from 'node:child_process';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Railway passes the deployed commit as a build arg (the Docker context has no .git); locally ask git.
const commit = () => {
  if (process.env.RAILWAY_GIT_COMMIT_SHA) return process.env.RAILWAY_GIT_COMMIT_SHA;
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()), __COMMIT__: JSON.stringify(commit()) },
  // same-origin /api in dev: session cookies and the Origin check work exactly as in production
  server: { port: 5173, proxy: { '/api': process.env.API_URL ?? 'http://localhost:3000' } },
});
