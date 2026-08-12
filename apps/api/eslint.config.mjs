import base from '@repo/config/eslint';

export default [
  ...base,
  {
    // Generated Prisma client is machine output — linting it is noise, and a hook
    // blocks editing it anyway.
    ignores: ['dist/**', 'generated/**', 'jest.config.cjs'],
  },
  {
    // Seeds and migration helpers are CLI scripts; their stdout IS the interface.
    files: ['prisma/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
];
