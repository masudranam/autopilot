import { defineConfig } from 'vitest/config';

// .mts rather than .ts: the package is CommonJS, and Vite's native config loader
// warns when it has to load ESM syntax from a file it treats as CJS.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
