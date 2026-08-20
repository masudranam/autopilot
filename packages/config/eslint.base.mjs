import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Base flat config for every TypeScript package in the monorepo.
 *
 * Packages compose it:
 *   import base from '@repo/config/eslint';
 *   export default [...base, { ...package-specific overrides }];
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '**/generated/**',
      '**/node_modules/**',
      '**/*.config.mjs',
      '**/*.config.js',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
    },

    rules: {
      // ---- Correctness that actually bites in this codebase ----
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'warn',

      // `any` erases the contract guarantees the whole design rests on.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // Unused code is dead weight; `_`-prefixed args are the intentional escape hatch.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Consistency
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',

      // ---- Project-specific invariants (see CLAUDE.md) ----
      // Money is integer minor units, never a float. `parseFloat` on a price and
      // `toFixed` for money formatting are the two ways that rule gets broken.
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message:
            'Money is stored as integer minor units — see CLAUDE.md §Backend. Use parseInt or a Money helper, never parseFloat on a monetary value.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          property: 'toFixed',
          message:
            'Do not format money with toFixed — use the Money formatter from @repo/contracts so rounding and currency stay consistent.',
        },
      ],
    },
  },

  // Tests get a longer leash: mocks legitimately need loose typing.
  {
    files: ['**/*.spec.ts', '**/*.test.ts', '**/*.e2e-spec.ts', '**/test/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      'no-restricted-properties': 'off',
    },
  },

  prettier,
);
