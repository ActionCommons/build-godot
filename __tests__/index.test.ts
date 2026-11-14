/**
 * © 2026-present Action Commons (https://github.com/ActionCommons)
 *
 * Unit tests for src/index.ts, the action entrypoint.
 */

import { jest } from '@jest/globals'

const run = jest.fn<() => Promise<void>>().mockResolvedValue()
jest.unstable_mockModule('../src/main.js', () => ({ run }))

describe('index.ts', () => {
  it('calls run() exactly once when imported', async () => {
    await import('../src/index.js')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
