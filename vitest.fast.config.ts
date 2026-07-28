import path from 'path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/** Fast unit/integration suite — no Chromium / WebGL browser gates. */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**', 'tests/browser/**'],
  },
});
