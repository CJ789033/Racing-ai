import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

// Which code is running (shown in the developer menu: ↑ ↑ ↓ ← →)
let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a git checkout */ }

export default defineConfig({
  base: './',
  build: { outDir: 'dist', chunkSizeWarningLimit: 1000 },
  define: {
    __BUILD_COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
});
