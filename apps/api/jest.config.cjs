/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/prisma'],
  // Both suffixes: '.spec.ts' (unit/integration) and Nest's '.e2e-spec.ts'. The
  // second is NOT covered by the first glob — 'health.e2e-spec.ts' ends in
  // '-spec.ts' — and a test file that silently never runs is a false green.
  testMatch: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
  // Integration tests talk to a real database; generous but bounded.
  testTimeout: 30_000,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
};
