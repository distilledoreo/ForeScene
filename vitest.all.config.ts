import path from 'path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/** Full Vitest tree: fast unit tests + browser-backed WebGL gates. */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
