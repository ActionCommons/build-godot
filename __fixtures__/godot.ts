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
  EDITOR_UNSUPPORTED_PLATFORMS,
  FLAVOR_PATTERN,
  GODOT3_ARCHITECTURES,
  GODOT3_MIN_TESTED_MINOR,
  GODOT3_OPTIMIZE_VALUES,
  GODOT3_PLATFORMS,
  GODOT3_SCONS_REQUIREMENT,
  GODOT3_TARGETS,
  GODOT4_ARCHITECTURES,
  MAX_TIMEOUT_SECONDS,
  OPTION_PLATFORMS,
  SUPPORTED_MAJORS,
  VALID_ARCHITECTURES,
  VALID_PLATFORMS,
  VALID_TARGETS,
  buildDownloadUrl,
  buildSconsArgs,
  parseMajorVersion,
  parseMultiInput,
  parseOptions,
  parseTimeout,
  parseVersion,
  resolveArchArg,
  validateFlavor,
  validateInputsForMajor
} from '../src/godot.js'
