import base from './eslint.base.mjs';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';

/**
 * Flat config for the Next.js apps (storefront, admin).
 *
 * Accessibility rules are errors, not warnings: WCAG AA is an acceptance criterion
 * on every user-facing feature (see CLAUDE.md § Frontend), so a11y regressions
 * have to fail the gate rather than accumulate as warnings nobody reads.
 */
export default [
  ...base,

  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
      '@next/next': nextPlugin,
    },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...jsxA11y.configs.recommended.rules,

      // a11y is a gate criterion, not advice.
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/anchor-is-valid': 'error',
      'jsx-a11y/label-has-associated-control': 'error',
      'jsx-a11y/no-autofocus': 'warn',

      // Server Components are the default; a stray hook in one is a build-time
      // failure that is much cheaper to catch here.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
];
