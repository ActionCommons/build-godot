/**
 * © 2026-present Action Commons (https://github.com/ActionCommons)
 *
 * Core logic for the build-godot GitHub Action.
 *
 * All functions that touch the filesystem or run external processes are kept
 * here so that they can be cleanly mocked in unit tests.
 */

import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as tc from '@actions/tool-cache'
import AdmZip from 'adm-zip'
import { spawn } from 'child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ── Constants ────────────────────────────────────────────────────────────────

export const VALID_PLATFORMS = [
  'android',
  'ios',
  'linuxbsd',
  'macos',
  'web',
  'windows'
] as const

export const VALID_TARGETS = [
  'editor',
  'template_debug',
  'template_release'
] as const

export const VALID_ARCHITECTURES = [
  'auto',
  'x86_32',
  'x86_64',
  'arm32',
  'arm64',
  'rv64',
  'ppc32',
  'ppc64',
  'wasm32'
] as const

export type Platform = (typeof VALID_PLATFORMS)[number]
export type Target = (typeof VALID_TARGETS)[number]
export type Architecture = (typeof VALID_ARCHITECTURES)[number]

export interface SconsOptions {
  /** Zip all header files after the build */
  create_header_archive?: boolean
  /** Pass debug_symbols=yes|no to SCons */
  debug_symbols?: 'yes' | 'no'
  /** Pass optimize=<level> to SCons */
  optimize?: 'speed_trace' | 'speed' | 'size' | 'debug' | 'none' | 'custom'
  /** Pass generate_bundle=yes|no to SCons (macOS / iOS .app bundle) */
  generate_bundle?: 'yes' | 'no'
  /** Pass ios_simulator=yes|no to SCons */
  ios_simulator?: 'yes' | 'no'
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Splits a comma- or newline-separated string into an array of trimmed,
 * non-empty tokens.
 */
export function parseMultiInput(input: string): string[] {
  return input
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Parses the action's `options` input into a {@link SconsOptions} object.
 * Throws on unrecognised tokens or invalid values.
 */
export function parseOptions(input: string): SconsOptions {
  const options: SconsOptions = {}
  if (!input || !input.trim()) return options

  for (const part of parseMultiInput(input)) {
    if (part === 'create_header_archive') {
      options.create_header_archive = true
    } else if (part.startsWith('debug_symbols=')) {
      const val = part.slice('debug_symbols='.length)
      if (val !== 'yes' && val !== 'no') {
        throw new Error(
          `Invalid debug_symbols value: "${val}". Must be "yes" or "no".`
        )
      }
      options.debug_symbols = val
    } else if (part.startsWith('optimize=')) {
      const val = part.slice('optimize='.length)
      const valid: string[] = [
        'speed_trace',
        'speed',
        'size',
        'debug',
        'none',
        'custom'
      ]
      if (!valid.includes(val)) {
        throw new Error(
          `Invalid optimize value: "${val}". Must be one of: ${valid.join(', ')}.`
        )
      }
      options.optimize = val as SconsOptions['optimize']
    } else if (part.startsWith('generate_bundle=')) {
      const val = part.slice('generate_bundle='.length)
      if (val !== 'yes' && val !== 'no') {
        throw new Error(
          `Invalid generate_bundle value: "${val}". Must be "yes" or "no".`
        )
      }
      options.generate_bundle = val
    } else if (part.startsWith('ios_simulator=')) {
      const val = part.slice('ios_simulator='.length)
      if (val !== 'yes' && val !== 'no') {
        throw new Error(
          `Invalid ios_simulator value: "${val}". Must be "yes" or "no".`
        )
      }
      options.ios_simulator = val
    } else {
      throw new Error(
        `Unknown option: "${part}". ` +
          `Supported: create_header_archive, debug_symbols=[yes|no], ` +
          `generate_bundle=[yes|no], ios_simulator=[yes|no], ` +
          `optimize=[speed_trace|speed|size|debug|none|custom].`
      )
    }
  }

  return options
}

/**
 * Returns the GitHub release download URL for a specific Godot version.
 *
 * Format:
 * `https://github.com/godotengine/godot-builds/releases/download/<ver>-<flavor>/godot-<ver>-<flavor>.tar.xz`
 */
export function buildDownloadUrl(version: string, flavor: string): string {
  const tag = `${version}-${flavor}`
  return `https://github.com/godotengine/godot-builds/releases/download/${tag}/godot-${tag}.tar.xz`
}

/**
 * Builds the SCons argument list for a single platform × target combination.
 */
export function buildSconsArgs(
  platform: string,
  target: string,
  architecture: string,
  options: SconsOptions
): string[] {
  const args: string[] = [`platform=${platform}`, `target=${target}`]

  if (architecture !== 'auto') {
    args.push(`arch=${architecture}`)
  }
  if (options.debug_symbols !== undefined) {
    args.push(`debug_symbols=${options.debug_symbols}`)
  }
  if (options.optimize !== undefined) {
    args.push(`optimize=${options.optimize}`)
  }
  if (options.generate_bundle !== undefined) {
    args.push(`generate_bundle=${options.generate_bundle}`)
  }
  if (options.ios_simulator !== undefined) {
    args.push(`ios_simulator=${options.ios_simulator}`)
  }

  return args
}

// ── Side-effectful operations ─────────────────────────────────────────────────

/**
 * Downloads the Godot source tarball for the given version + flavor and
 * extracts it into `directory`.
 *
 * Returns the absolute path to the extracted source directory
 * (e.g. `<directory>/godot-4.4-stable`).
 */
export async function downloadAndExtract(
  version: string,
  flavor: string,
  directory: string
): Promise<string> {
  const url = buildDownloadUrl(version, flavor)
  core.info(`Downloading Godot ${version}-${flavor} from ${url}`)

  const tarPath = await tc.downloadTool(url)
  core.info(`Extracting archive into ${directory}`)

  // .tar.xz → flags 'xJ' → tar -C <dest> xJ -f <file>
  await tc.extractTar(tarPath, directory, 'xJ')

  // The tarball conventionally unpacks to godot-<version>-<flavor>/.
  // Find the extracted directory robustly in case the name differs slightly.
  const entries = fs.readdirSync(directory)
  const extractedEntry = entries.find((e) => {
    const fullPath = path.join(directory, e)
    return fs.statSync(fullPath).isDirectory() && e.startsWith('godot-')
  })

  if (!extractedEntry) {
    throw new Error(
      `Extraction succeeded but no "godot-*" directory was found in ${directory}. ` +
        `Entries: ${entries.join(', ')}`
    )
  }

  const sourceDir = path.join(directory, extractedEntry)
  core.info(`Godot source available at: ${sourceDir}`)
  return sourceDir
}

/**
 * Installs SCons via pip3 so the Godot build system can be invoked.
 */
export async function setupScons(): Promise<void> {
  core.info('Installing SCons via pip3...')
  await exec.exec('pip3', [
    'install',
    '--quiet',
    '--break-system-packages',
    'scons'
  ])
}

/**
 * Runs the Godot SCons build for every platform × target combination.
 * Optionally enforces a wall-clock timeout (in seconds; 0 = unlimited).
 *
 * A separate `scons` invocation is made for each combination so that
 * partial failures are attributable to a specific build.
 *
 * Uses buildSconsArgs so that all parsed options (debug_symbols,
 * optimize, etc.) are correctly passed to SCons.
 */
export async function runBuild(
  sourceDir: string,
  platforms: string[],
  targets: string[],
  architecture: string,
  options: SconsOptions,
  timeoutSeconds: number,
  onTimeout?: () => Promise<void>
): Promise<void> {
  for (const platform of platforms) {
    for (const target of targets) {
      const args = buildSconsArgs(platform, target, architecture, options)

      core.info(`Building: scons ${args.join(' ')}`)

      const timedOut = await spawnWithTimeout(
        'scons',
        args,
        sourceDir,
        timeoutSeconds * 1000,
        onTimeout
      )

      if (timedOut) {
        core.warning('Build loop terminated due to timeout.')
        return
      }
    }
  }
}

/**
 * Spawns `command` with `args` in `cwd`, optionally killing it after
 * `timeoutMs` milliseconds (pass 0 for no timeout).
 *
 * Stdio is inherited so SCons output streams directly to the runner log.
 * When a timeout occurs (SIGTERM), the build is treated as success
 * (no fail signal) because the timeout was explicitly configured by the user.
 * This is expected behavior in the CI test matrix and for users who want
 * a hard time limit.
 *
 * Rejects only on real failures (non-zero exit code or other signals).
 */
export async function spawnWithTimeout(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onTimeout?: () => Promise<void>
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })

    let timer: ReturnType<typeof setTimeout> | undefined = undefined
    let isTimeout = false

    if (timeoutMs > 0) {
      timer = setTimeout(async () => {
        isTimeout = true
        core.info('Timeout reached. Securing headers before termination...')

        if (onTimeout) {
          try {
            await onTimeout()
          } catch (err) {
            core.error(`Header archiving failed during timeout: ${err}`)
          }
        }

        child.kill('SIGTERM')
      }, timeoutMs)
    }

    child.on('exit', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer)

      if (isTimeout || signal === 'SIGTERM') {
        resolve(true)
      } else if (signal) {
        reject(new Error(`Build process killed by signal ${signal}`))
      } else if (code !== 0) {
        reject(
          new Error(
            `Build exited with code ${code} (${args.slice(0, 2).join(' ')})`
          )
        )
      } else {
        resolve(false)
      }
    })

    child.on('error', (err) => {
      if (timer !== undefined) clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * Creates a ZIP archive containing every `*.glsl`, `*.h`, `*.hh`, `*.hpp`,
 * `*.inc`, and `*.inl` file found anywhere under `sourceDir`, preserving
 * relative paths.
 *
 * Uses a synchronous recursive directory walk (fs.readdirSync with
 * withFileTypes) instead of an async glob library. This is reliable even
 * when SCons is still running and actively writing files, because each
 * readdir call is a single, atomic syscall on a directory snapshot — there
 * is no async scheduling gap in which the library can lose track of entries.
 *
 * Returns the absolute path of the created archive.
 */
export async function createHeaderArchive(sourceDir: string): Promise<string> {
  const absoluteSource = path.resolve(sourceDir)
  core.info(`Collecting header files from: ${absoluteSource}`)

  const headerFiles: string[] = []

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walkDir(fullPath)
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.glsl') ||
          entry.name.endsWith('.h') ||
          entry.name.endsWith('.hh') ||
          entry.name.endsWith('.hpp') ||
          entry.name.endsWith('.inc') ||
          entry.name.endsWith('.inl'))
      ) {
        headerFiles.push(fullPath)
      }
    }
  }

  walkDir(absoluteSource)

  if (headerFiles.length === 0) {
    core.warning('No header files found; the header archive will be empty.')
  } else {
    core.info(`Found ${headerFiles.length} header file(s).`)
  }

  const zip = new AdmZip()
  for (const file of headerFiles) {
    const relative = path.relative(absoluteSource, file)
    const zipDir = path.dirname(relative)
    // Preserves directory structure
    zip.addLocalFile(file, zipDir === '.' ? '' : zipDir)
  }

  const archivePath = path.join(os.tmpdir(), `godot-headers-${Date.now()}.zip`)
  zip.writeZip(archivePath)

  core.info(`Header archive written to ${archivePath}`)
  return archivePath
}
