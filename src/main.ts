/**
 * © 2026-present Action Commons (https://github.com/ActionCommons)
 */

import * as core from '@actions/core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  VALID_ARCHITECTURES,
  VALID_PLATFORMS,
  VALID_TARGETS,
  createHeaderArchive,
  downloadAndExtract,
  parseMultiInput,
  parseOptions,
  runBuild,
  setupScons
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

    const timeoutSeconds = parseInt(timeoutInput, 10)
    if (isNaN(timeoutSeconds) || timeoutSeconds < 0) {
      throw new Error(
        `Invalid timeout value: "${timeoutInput}". ` +
          `Must be a non-negative integer (0 = no timeout).`
      )
    }

    // parseOptions throws on invalid option tokens
    const options = parseOptions(optionsInput)

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
    await setupScons()

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
      archiveHeaders
    )

    // Final check for normal completion
    await archiveHeaders()
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}
