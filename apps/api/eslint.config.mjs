import base from '@repo/config/eslint';

export default [
  ...base,
  {
    // Generated Prisma client is machine output — linting it is noise, and a hook
    // blocks editing it anyway.
    ignores: [
      'dist/**',
      'generated/**',
      'jest.config.cjs',
      // Plain-JS helpers are outside the tsconfig project, so the type-aware config
      // cannot resolve them. They are `node --check`ed by virtue of being run in CI.
      'scripts/**/*.mjs',
    ],
  },
  {
    // Seeds, migration helpers and CI assertions are CLI scripts; their stdout IS the
    // interface, so console is the intended output channel.
    files: ['prisma/**/*.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
];
