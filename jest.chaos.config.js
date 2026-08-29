module.exports = {
  displayName: 'chaos',
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/chaos/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { diagnostics: false }],
  },
  testTimeout: 30000,
};
