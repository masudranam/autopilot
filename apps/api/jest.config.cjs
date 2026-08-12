/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/prisma'],
  testMatch: ['**/*.spec.ts'],
  // Integration tests talk to a real database; generous but bounded.
  testTimeout: 30_000,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
};
