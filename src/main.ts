/**
 * © 2026-present Action Commons (https://github.com/ActionCommons)
 */

import * as core from '@actions/core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  GODOT3_MIN_TESTED_MINOR,
  VALID_ARCHITECTURES,
  VALID_PLATFORMS,
  VALID_TARGETS,
  createHeaderArchive,
  downloadAndExtract,
  parseMultiInput,
  parseOptions,
  parseTimeout,
  parseVersion,
  runBuild,
  setupScons,
  validateFlavor,
  validateInputsForMajor
} from './godot.js'

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    // ── Read inputs ────────────────────────────────────────────────────────
    const version = core.getInput('version', { required: true })
    const flavor = core.getInput('flavor') || 'stable'
    const directoryInput = core.getInput('directory')
    const timeoutInput = core.getInput('timeout') || '0'
    const platformInput = core.getInput('platform', { required: true })
    const targetInput = core.getInput('target', { required: true })
    const architectureInput = core.getInput('architecture') || 'auto'
    const optionsInput = core.getInput('options') || ''

    // ── Detect Godot major version (before any download) ───────────────────
    const { major, minor } = parseVersion(version)
    core.info(`Detected Godot major version: ${major}.x`)
    if (major === 3 && minor < GODOT3_MIN_TESTED_MINOR) {
      core.warning(
        `Godot ${version} is older than 3.${GODOT3_MIN_TESTED_MINOR}, the ` +
          `oldest 3.x release this action is tested with. The build may ` +
          `fail with the toolchains available on current runners.`
      )
    }

    validateFlavor(flavor)

    // ── Validate & parse multi-value inputs ────────────────────────────────
    const platforms = parseMultiInput(platformInput)
    const targets = parseMultiInput(targetInput)

    if (platforms.length === 0) {
      throw new Error('At least one platform must be specified.')
    }
    if (targets.length === 0) {
      throw new Error('At least one target must be specified.')
    }

    for (const p of platforms) {
      if (!VALID_PLATFORMS.includes(p as (typeof VALID_PLATFORMS)[number])) {
        throw new Error(
          `Invalid platform: "${p}". ` +
            `Must be one of: ${VALID_PLATFORMS.join(', ')}.`
        )
      }
    }

    for (const t of targets) {
      if (!VALID_TARGETS.includes(t as (typeof VALID_TARGETS)[number])) {
        throw new Error(
          `Invalid target: "${t}". ` +
            `Must be one of: ${VALID_TARGETS.join(', ')}.`
        )
      }
    }

    if (
      !VALID_ARCHITECTURES.includes(
        architectureInput as (typeof VALID_ARCHITECTURES)[number]
      )
    ) {
      throw new Error(
        `Invalid architecture: "${architectureInput}". ` +
          `Must be one of: ${VALID_ARCHITECTURES.join(', ')}.`
      )
    }

    const timeoutSeconds = parseTimeout(timeoutInput)

    // parseOptions throws on invalid option tokens
    const options = parseOptions(optionsInput)

    // Reject inputs that cannot be expressed for the detected major version
    validateInputsForMajor(
      major,
      platforms,
      targets,
      architectureInput,
      options
    )

    // ── Resolve working directory ──────────────────────────────────────────
    const directory = directoryInput
      ? path.resolve(directoryInput)
      : fs.mkdtempSync(path.join(os.tmpdir(), 'godot-build-'))

    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true })
    }

    core.info(`Working directory (absolute): ${directory}`)
    core.setOutput('directory', directory)

    // ── Download & extract source ──────────────────────────────────────────
    const sourceDir = await downloadAndExtract(version, flavor, directory)

    // ── Set up SCons ───────────────────────────────────────────────────────
    await setupScons(major)

    // ── Header Archiving Logic ─────────────────────────────────────────────
    let headerArchiveCreated = false
    const archiveHeaders = async () => {
      if (options.create_header_archive && !headerArchiveCreated) {
        const archivePath = await createHeaderArchive(sourceDir)
        core.setOutput('header_archive', archivePath)
        core.info(`Header archive secured: ${archivePath}`)
        headerArchiveCreated = true
      }
    }

    // Run build with the archiveHeaders function as the timeout callback
    await runBuild(
      sourceDir,
      platforms,
      targets,
      architectureInput,
      options,
      timeoutSeconds,
      archiveHeaders,
      major
    )

    // Final check for normal completion
    await archiveHeaders()
  } catch (error) {
    // Anything thrown must fail the step; a non-Error value (e.g. a raw
    // string from a library) previously let the step succeed silently.
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}
