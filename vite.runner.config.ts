import { defineConfig } from 'vite';
import { resolve } from 'path';

// Separate build that bundles the background-runner entry into a single
// standalone JS asset (no React/DOM). Capacitor's background-runner loads
// this file in its sandboxed JS context. Output: dist-runner/runner.js
export default defineConfig({
  build: {
    outDir: 'dist-runner',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/runner/overkill.runner.ts'),
      formats: ['es'],
      fileName: () => 'runner.js',
    },
    rollupOptions: {
      // The runner sandbox provides these globals at runtime; never bundle them.
      external: [],
    },
    target: 'es2020',
    minify: false,
  },
});
