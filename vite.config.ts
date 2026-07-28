import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    // Module workers (coverageClient) need ES output; IIFE cannot code-split.
    worker: {
      format: 'es' as const,
    },
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          'e2e-mp4-encode': path.resolve(__dirname, 'e2e/harness/mp4-encode.html'),
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    test: {
      include: ['tests/**/*.{test,spec}.{ts,tsx}'],
      // Default includes browser gates so path-targeted runs work:
      //   npx vitest run tests/browser/<file>.test.ts
      // `npm run test` / `test:changed` use vitest.fast.config.ts to skip them.
      exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    },
  };
});
