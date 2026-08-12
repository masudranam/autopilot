import js from '@eslint/js';
import globals from 'globals';

/**
 * This package lints itself.
 *
 * It deliberately does NOT use eslint.base.mjs: that config is type-aware
 * (`projectService: true`), and these files are plain ESM with no tsconfig covering
 * them, so type-aware rules cannot resolve them. Untyped recommended rules still
 * catch the things that actually break a config file — undefined identifiers, unused
 * imports, unreachable code.
 *
 * Without this, `packages/config` had no lint script at all and Turbo skipped it
 * silently, leaving the shared bases every other package depends on unchecked.
 */
export default [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
];
