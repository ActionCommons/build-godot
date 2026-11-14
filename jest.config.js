// See: https://jestjs.io/docs/configuration

/** @type {import('ts-jest').JestConfigWithTsJest} **/
export default {
  clearMocks: true,
  collectCoverage: true,
  collectCoverageFrom: ['./src/**'],
  coverageDirectory: './coverage',
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  coverageReporters: ['json-summary', 'text', 'lcov'],
  // Fail the test run (and CI) if coverage drops below 100%.
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100
    }
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleFileExtensions: ['ts', 'js'],
  preset: 'ts-jest',
  reporters: ['default'],
  resolver: 'ts-jest-resolver',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/dist/', '/node_modules/'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
        useESM: true
      }
    ]
  },
  verbose: true
}
