module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testTimeout: 15000,
  moduleNameMapper: {
    '^node-fetch$': '<rootDir>/src/gitea/fetchShim.js',
  },
}
