/**
 * © 2026-present Action Commons (https://github.com/ActionCommons)
 *
 * Mutation testing for src/godot.ts and src/main.ts.
 * Line/branch coverage is already 100%; the mutation score shows whether the
 * tests would actually notice a behavioural change.
 *
 * Run with: npm run test:mutation
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  testRunner: 'jest',
  jest: {
    configFile: 'jest.config.js',
    enableFindRelatedTests: false
  },
  // Jest runs in ESM mode, which requires the VM-modules flag in each worker.
  testRunnerNodeArgs: ['--experimental-vm-modules', '--no-warnings'],
  mutate: ['src/godot.ts', 'src/main.ts'],
  // Coverage thresholds are enforced by `npm test`, not per mutant run.
  disableTypeChecks: true,
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  thresholds: { high: 90, low: 80, break: 80 },
  tempDirName: '.stryker-tmp'
}
