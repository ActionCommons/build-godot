/**
 * © 2026-present Action Commons (https://github.com/ActionCommons)
 *
 * Fixture that mocks every side-effectful function exported from src/godot.ts
 * while re-exporting the pure helpers directly so they can be exercised in
 * unit tests without additional mocking.
 */
import type * as godot from '../src/godot.js'
import { jest } from '@jest/globals'

// Mocked side-effectful functions
export const downloadAndExtract = jest.fn<typeof godot.downloadAndExtract>()
export const setupScons = jest.fn<typeof godot.setupScons>()
export const runBuild = jest.fn<typeof godot.runBuild>()
export const createHeaderArchive = jest.fn<typeof godot.createHeaderArchive>()

// Re-export pure helpers so main.test.ts can import the whole module from here
export {
  VALID_ARCHITECTURES,
  VALID_PLATFORMS,
  VALID_TARGETS,
  buildDownloadUrl,
  buildSconsArgs,
  parseMultiInput,
  parseOptions
} from '../src/godot.js'
