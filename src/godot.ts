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
import { spawn, type ChildProcess } from 'child_process'
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

/** Godot major versions this action knows how to build. */
export const SUPPORTED_MAJORS = [3, 4] as const
export type GodotMajor = (typeof SUPPORTED_MAJORS)[number]

// ── Godot 3.x translation tables ─────────────────────────────────────────────
//
// The action's public vocabulary is the Godot 4.x one. When building a 3.x
// tree, the inputs are translated into the SCons arguments Godot 3 expects.

/** 4.x platform name → 3.x SCons `platform=` value. */
export const GODOT3_PLATFORMS: Readonly<Record<Platform, string>> = {
  android: 'android',
  ios: 'iphone',
  linuxbsd: 'x11',
  macos: 'osx',
  web: 'javascript',
  windows: 'windows'
}

/** 4.x target name → 3.x `tools=` + `target=` SCons arguments. */
export const GODOT3_TARGETS: Readonly<Record<Target, readonly string[]>> = {
  editor: ['tools=yes', 'target=release_debug'],
  template_debug: ['tools=no', 'target=release_debug'],
  template_release: ['tools=no', 'target=release']
}

/**
 * 4.x architecture → 3.x SCons argument, per 4.x platform name.
 * Godot 3 has no universal `arch=` flag: x86 desktop builds use `bits=`,
 * Android uses `android_arch=`, and only macOS / iOS accept `arch=`.
 * Architectures missing from a platform's map are rejected for 3.x.
 */
export const GODOT3_ARCHITECTURES: Readonly<
  Record<Platform, Readonly<Partial<Record<Architecture, string>>>>
> = {
  android: {
    x86_32: 'android_arch=x86',
    x86_64: 'android_arch=x86_64',
    arm32: 'android_arch=armv7',
    arm64: 'android_arch=arm64v8'
  },
  ios: { arm64: 'arch=arm64' },
  linuxbsd: { x86_32: 'bits=32', x86_64: 'bits=64' },
  macos: { x86_64: 'arch=x86_64', arm64: 'arch=arm64' },
  web: {},
  windows: { x86_32: 'bits=32', x86_64: 'bits=64' }
}

/** `optimize=` values understood by the Godot 3.x build system. */
export const GODOT3_OPTIMIZE_VALUES = ['speed', 'size', 'none'] as const

/** SCons version range to install when building Godot 3.x. */
export const GODOT3_SCONS_REQUIREMENT = 'scons<4.8'

/** Oldest Godot 3.x minor version this action is tested against. */
export const GODOT3_MIN_TESTED_MINOR = 5

/**
 * Architectures accepted by the Godot 4.x SCons platform detectors
 * (`supported_arches` in each `platform/<name>/detect.py`). Anything else
 * fails inside SCons, so it is rejected before the download.
 */
export const GODOT4_ARCHITECTURES: Readonly<
  Record<Platform, readonly Architecture[]>
> = {
  android: ['x86_32', 'x86_64', 'arm32', 'arm64'],
  ios: ['x86_64', 'arm64'],
  linuxbsd: ['x86_32', 'x86_64', 'arm32', 'arm64', 'rv64', 'ppc32', 'ppc64'],
  macos: ['x86_64', 'arm64'],
  web: ['wasm32'],
  windows: ['x86_32', 'x86_64', 'arm32', 'arm64']
}

/**
 * Platforms that have no editor build, per major version. Godot 3.x has no
 * Android or iOS editor; Godot 4.x has an Android editor but no iOS editor.
 */
export const EDITOR_UNSUPPORTED_PLATFORMS: Readonly<
  Record<GodotMajor, readonly Platform[]>
> = {
  3: ['android', 'ios'],
  4: ['ios']
}

/** Platform-specific options and the platforms they may be used with. */
export const OPTION_PLATFORMS: Readonly<
  Record<'generate_bundle' | 'ios_simulator', readonly Platform[]>
> = {
  generate_bundle: ['macos', 'ios'],
  ios_simulator: ['ios']
}

/**
 * Largest timeout (in seconds) that fits in a Node.js timer. setTimeout
 * silently fires after 1 ms for delays above 2^31 - 1 milliseconds.
 */
export const MAX_TIMEOUT_SECONDS = Math.floor(2147483647 / 1000)

/**
 * Grace period (ms) between SIGTERM and SIGKILL when a timed-out build does
 * not exit on its own. SCons normally exits within a second of SIGTERM.
 */
export const SIGTERM_GRACE_MS = 10_000

/** Release flavors published on godotengine/godot-builds. */
export const FLAVOR_PATTERN = /^(stable|(dev|alpha|beta|rc)[1-9]\d*)$/

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
 * non-empty, unique tokens (first occurrence wins, order preserved).
 * Deduplication prevents e.g. `linuxbsd, linuxbsd` from building twice.
 */
export function parseMultiInput(input: string): string[] {
  const tokens = input
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return [...new Set(tokens)]
}

/**
 * Parses the `timeout` input (seconds). Only plain non-negative integers are
 * accepted: `parseInt` would silently turn `"10abc"` into 10 and `"1.5"`
 * into 1. Values above {@link MAX_TIMEOUT_SECONDS} are rejected because they
 * overflow Node's timer and would fire almost immediately.
 */
export function parseTimeout(input: string): number {
  if (!/^\d+$/.test(input)) {
    throw new Error(
      `Invalid timeout value: "${input}". ` +
        `Must be a non-negative integer number of seconds (0 = no timeout).`
    )
  }
  const seconds = parseInt(input, 10)
  if (seconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(
      `Invalid timeout value: "${input}". ` +
        `Must not exceed ${MAX_TIMEOUT_SECONDS} seconds (about 24.8 days).`
    )
  }
  return seconds
}

/**
 * Validates the `flavor` input against the naming used by
 * godotengine/godot-builds (`stable`, `devN`, `alphaN`, `betaN`, `rcN`), so
 * typos fail immediately instead of as a 404 during download.
 */
export function validateFlavor(flavor: string): void {
  if (!FLAVOR_PATTERN.test(flavor)) {
    throw new Error(
      `Invalid flavor: "${flavor}". ` +
        `Must be "stable" or one of devN, alphaN, betaN, rcN (e.g. "rc1").`
    )
  }
}

/**
 * Parses the action's `options` input into a {@link SconsOptions} object.
 * Throws on unrecognised tokens or invalid values.
 */
export function parseOptions(input: string): SconsOptions {
  const options: SconsOptions = {}

  // Rejects the same option given twice with different values, e.g.
  // "optimize=speed, optimize=size" (identical repeats are deduplicated).
  const assertUnset = (key: keyof SconsOptions, val: string): void => {
    const existing = options[key]
    if (existing !== undefined) {
      throw new Error(
        `Conflicting values for option "${key}": "${existing}" and "${val}".`
      )
    }
  }

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
      assertUnset('debug_symbols', val)
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
      assertUnset('optimize', val)
      options.optimize = val as SconsOptions['optimize']
    } else if (part.startsWith('generate_bundle=')) {
      const val = part.slice('generate_bundle='.length)
      if (val !== 'yes' && val !== 'no') {
        throw new Error(
          `Invalid generate_bundle value: "${val}". Must be "yes" or "no".`
        )
      }
      assertUnset('generate_bundle', val)
      options.generate_bundle = val
    } else if (part.startsWith('ios_simulator=')) {
      const val = part.slice('ios_simulator='.length)
      if (val !== 'yes' && val !== 'no') {
        throw new Error(
          `Invalid ios_simulator value: "${val}". Must be "yes" or "no".`
        )
      }
      assertUnset('ios_simulator', val)
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

/** Components of a parsed `version` input. */
export interface GodotVersion {
  major: GodotMajor
  minor: number
  patch?: number
}

/**
 * Parses the `version` input (e.g. `"3.6"`, `"4.6.1"`) into its components.
 *
 * Accepts `MAJOR.MINOR` or `MAJOR.MINOR.PATCH` without leading zeros. A `.0`
 * patch is rejected because godot-builds tags omit it (`4.4`, not `4.4.0`),
 * so the download would 404. Throws on malformed input or an unsupported
 * major version.
 */
export function parseVersion(version: string): GodotVersion {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.exec(version)
  if (!match) {
    throw new Error(
      `Invalid version: "${version}". ` +
        `Expected MAJOR.MINOR or MAJOR.MINOR.PATCH such as "4.4" or "3.5.3".`
    )
  }

  if (match[3] === '0') {
    throw new Error(
      `Invalid version: "${version}". ` +
        `Godot release tags omit a ".0" patch; use "${match[1]}.${match[2]}".`
    )
  }

  const major = parseInt(match[1], 10)
  if (!SUPPORTED_MAJORS.includes(major as GodotMajor)) {
    throw new Error(
      `Unsupported Godot major version: ${major} (from "${version}"). ` +
        `Supported major versions: ${SUPPORTED_MAJORS.join(', ')}.`
    )
  }

  return {
    major: major as GodotMajor,
    minor: parseInt(match[2], 10),
    ...(match[3] !== undefined && { patch: parseInt(match[3], 10) })
  }
}

/** Returns only the major component of {@link parseVersion}. */
export function parseMajorVersion(version: string): GodotMajor {
  return parseVersion(version).major
}

/**
 * Resolves the SCons architecture argument for a platform and major version.
 *
 * Returns `undefined` for `auto` (no argument; SCons detects the host).
 * Throws when the platform cannot be built for that architecture. This is
 * the single source of truth used by both {@link validateInputsForMajor}
 * and {@link buildSconsArgs}, so both report the same error.
 */
export function resolveArchArg(
  platform: string,
  architecture: string,
  major: GodotMajor
): string | undefined {
  if (architecture === 'auto') return undefined

  let mapped: string | undefined
  let supported: string[]
  if (major === 3) {
    const table = GODOT3_ARCHITECTURES[platform as Platform]
    mapped = table[architecture as Architecture]
    supported = Object.keys(table)
  } else {
    const allowed = GODOT4_ARCHITECTURES[platform as Platform]
    if (allowed.includes(architecture as Architecture)) {
      mapped = `arch=${architecture}`
    }
    supported = [...allowed]
  }

  if (mapped === undefined) {
    throw new Error(
      `Architecture "${architecture}" is not supported for platform ` +
        `"${platform}" when building Godot ${major}.x. ` +
        (supported.length > 0
          ? `Supported: auto, ${supported.join(', ')}.`
          : `Only "auto" is supported.`)
    )
  }
  return mapped
}

/**
 * Validates that the (already individually validated) inputs can be built
 * for the given Godot major version, so incompatible combinations fail
 * before anything is downloaded:
 *
 * - architecture must be supported by every requested platform;
 * - `editor` must not be requested for platforms without an editor build;
 * - `ios_simulator` / `generate_bundle` only with the platforms they apply to;
 * - Godot 3.x additionally rejects `generate_bundle` and 4.x-only optimize
 *   levels.
 */
export function validateInputsForMajor(
  major: GodotMajor,
  platforms: string[],
  targets: string[],
  architecture: string,
  options: SconsOptions
): void {
  for (const platform of platforms) {
    resolveArchArg(platform, architecture, major)
  }

  if (targets.includes('editor')) {
    const noEditor = EDITOR_UNSUPPORTED_PLATFORMS[major]
    const offending = platforms.find((p) => noEditor.includes(p as Platform))
    if (offending !== undefined) {
      throw new Error(
        `Target "editor" is not available for platform "${offending}" ` +
          `when building Godot ${major}.x. ` +
          `Use template_debug or template_release instead.`
      )
    }
  }

  if (major === 3) {
    if (options.generate_bundle !== undefined) {
      throw new Error(
        `generate_bundle is only supported when building Godot 4.x. ` +
          `Godot 3.x creates app bundles via the scripts in misc/dist instead.`
      )
    }
    if (
      options.optimize !== undefined &&
      !(GODOT3_OPTIMIZE_VALUES as readonly string[]).includes(options.optimize)
    ) {
      throw new Error(
        `optimize=${options.optimize} is not supported when building Godot 3.x. ` +
          `Supported: ${GODOT3_OPTIMIZE_VALUES.join(', ')}.`
      )
    }
  }

  for (const key of Object.keys(OPTION_PLATFORMS) as Array<
    keyof typeof OPTION_PLATFORMS
  >) {
    if (options[key] === undefined) continue
    const allowed = OPTION_PLATFORMS[key]
    const offending = platforms.find((p) => !allowed.includes(p as Platform))
    if (offending !== undefined) {
      throw new Error(
        `Option "${key}" is only supported for platform(s) ` +
          `${allowed.join(', ')}, but "${offending}" was requested.`
      )
    }
  }
}

/**
 * Builds the SCons argument list for a single platform × target combination.
 *
 * `platform`, `target` and `architecture` always use the Godot 4.x names;
 * for Godot 3.x they are translated via the GODOT3_* tables.
 */
export function buildSconsArgs(
  platform: string,
  target: string,
  architecture: string,
  options: SconsOptions,
  major: GodotMajor = 4
): string[] {
  const args: string[] =
    major === 3
      ? [
          `platform=${GODOT3_PLATFORMS[platform as Platform]}`,
          ...GODOT3_TARGETS[target as Target]
        ]
      : [`platform=${platform}`, `target=${target}`]

  const archArg = resolveArchArg(platform, architecture, major)
  if (archArg !== undefined) {
    args.push(archArg)
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

  // The tarball unpacks to godot-<version>-<flavor>/. Prefer that exact name:
  // a reused working directory may already contain other godot-* trees (e.g.
  // a cached 3.x checkout next to a 4.x one) and picking the first match
  // would silently build the wrong version.
  // Only godot-* entries are stat'ed: a user-supplied working directory (for
  // example a repository checkout) may contain unrelated entries, and a
  // dangling symlink among them must not abort the build. A dangling godot-*
  // symlink is simply not a directory.
  const expected = `godot-${version}-${flavor}`
  const entries = fs.readdirSync(directory)
  const candidates = entries.filter(
    (e) => e.startsWith('godot-') && isDirectory(path.join(directory, e))
  )

  let extractedEntry: string
  if (candidates.includes(expected)) {
    extractedEntry = expected
  } else if (candidates.length === 1) {
    extractedEntry = candidates[0]
  } else if (candidates.length === 0) {
    throw new Error(
      `Extraction succeeded but no "godot-*" directory was found in ${directory}. ` +
        `Entries: ${entries.join(', ')}`
    )
  } else {
    throw new Error(
      `Expected "${expected}" in ${directory} but found several other ` +
        `godot-* directories: ${candidates.join(', ')}. ` +
        `Use an empty working directory.`
    )
  }

  const sourceDir = path.join(directory, extractedEntry)
  core.info(`Godot source available at: ${sourceDir}`)
  return sourceDir
}

/** True when `p` resolves (following symlinks) to a directory. */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Installs SCons via pip3 so the Godot build system can be invoked.
 *
 * Godot 3.x build scripts are not compatible with recent SCons releases, so a
 * pinned version range is installed when building a 3.x tree.
 */
export async function setupScons(major: GodotMajor = 4): Promise<void> {
  const requirement = major === 3 ? GODOT3_SCONS_REQUIREMENT : 'scons'
  core.info(`Installing SCons via pip3 (${requirement})...`)
  await exec.exec('pip3', [
    'install',
    '--quiet',
    '--break-system-packages',
    requirement
  ])
}

/**
 * Runs the Godot SCons build for every platform × target combination.
 * Optionally enforces a wall-clock timeout (in seconds; 0 = unlimited) that
 * covers all combinations together.
 *
 * A separate `scons` invocation is made for each combination so that
 * partial failures are attributable to a specific build.
 *
 * Uses buildSconsArgs so that all parsed options (debug_symbols,
 * optimize, etc.) are correctly passed to SCons and translated for the
 * requested Godot major version.
 */
export async function runBuild(
  sourceDir: string,
  platforms: string[],
  targets: string[],
  architecture: string,
  options: SconsOptions,
  timeoutSeconds: number,
  onTimeout?: () => Promise<void>,
  major: GodotMajor = 4
): Promise<void> {
  // The timeout bounds the whole run, not each SCons invocation: every
  // invocation only gets the time that is left until the shared deadline.
  const deadline =
    timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1000 : undefined

  for (const platform of platforms) {
    for (const target of targets) {
      let remainingMs = 0
      if (deadline !== undefined) {
        remainingMs = deadline - Date.now()
        if (remainingMs <= 0) {
          core.info('Timeout reached between builds. Securing headers...')
          await runTimeoutCallback(onTimeout)
          core.warning('Build loop terminated due to timeout.')
          return
        }
      }

      const args = buildSconsArgs(
        platform,
        target,
        architecture,
        options,
        major
      )

      core.info(`Building: scons ${args.join(' ')}`)

      const timedOut = await spawnWithTimeout(
        'scons',
        args,
        sourceDir,
        remainingMs,
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
 * Invokes the optional timeout callback, logging (not propagating) failures
 * so that a failed header archive never prevents the build from stopping.
 */
async function runTimeoutCallback(
  onTimeout?: () => Promise<void>
): Promise<void> {
  if (!onTimeout) return
  try {
    await onTimeout()
  } catch (err) {
    core.error(`Header archiving failed during timeout: ${err}`)
  }
}

/**
 * Spawns `command` with `args` in `cwd`, optionally killing it after
 * `timeoutMs` milliseconds (pass 0 for no timeout).
 *
 * Stdio is inherited so SCons output streams directly to the runner log. On
 * POSIX the child is started in its own process group so that the timeout
 * signal reaches SCons' compiler children as well, not just SCons itself.
 *
 * Timeout sequence: the `onTimeout` callback runs first (it archives headers
 * while the build is still in a consistent state), then the process group
 * receives SIGTERM, and SIGKILL follows after {@link SIGTERM_GRACE_MS} if the
 * build has not exited by then. A build stopped this way is treated as
 * success (resolves `true`) because the timeout was explicitly configured.
 *
 * A build that exits on its own *before* the kill is requested, including
 * while `onTimeout` is still running, is judged on its own exit status: a
 * non-zero exit is a real failure and must not be masked by the timeout.
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
    const detached = process.platform !== 'win32'
    const child = spawn(command, args, { cwd, stdio: 'inherit', detached })

    let timer: ReturnType<typeof setTimeout> | undefined = undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined = undefined
    let killRequested = false
    let exited = false
    // Pending onTimeout work; exit handling waits for it so the caller never
    // observes a half-written header archive.
    let timeoutWork: Promise<void> | undefined = undefined

    const requestKill = (): void => {
      if (exited) return
      killRequested = true
      signalBuild(child, 'SIGTERM')
      killTimer = setTimeout(() => {
        core.warning(
          `Build did not exit ${SIGTERM_GRACE_MS} ms after SIGTERM; sending SIGKILL.`
        )
        signalBuild(child, 'SIGKILL')
      }, SIGTERM_GRACE_MS)
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        core.info('Timeout reached. Securing headers before termination...')
        if (onTimeout) {
          timeoutWork = runTimeoutCallback(onTimeout).then(requestKill)
        } else {
          requestKill()
        }
      }, timeoutMs)
    }

    child.on('exit', (code, signal) => {
      exited = true
      if (timer !== undefined) clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)

      const settle = (): void => {
        if (killRequested || signal === 'SIGTERM') {
          resolve(true)
        } else if (signal) {
          reject(new Error(`Build process killed by signal ${signal}`))
        } else if (code !== 0) {
          reject(
            new Error(`Build exited with code ${code} (${describeBuild(args)})`)
          )
        } else {
          resolve(false)
        }
      }

      if (timeoutWork !== undefined) {
        void timeoutWork.then(settle)
      } else {
        settle()
      }
    })

    child.on('error', (err) => {
      if (timer !== undefined) clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      reject(err)
    })
  })
}

/**
 * Sends `signal` to the build. On POSIX the whole process group is signalled
 * (the child was spawned detached, so its pid is the group id) and SCons'
 * compiler children stop too; `child.kill` is the fallback when the group is
 * already gone or the platform has no process groups.
 */
function signalBuild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Group already gone; fall through to the plain kill.
    }
  }
  child.kill(signal)
}

/**
 * Names the build in error messages by its platform/target arguments only
 * (`platform=`, `tools=`, `target=`), so 3.x builds, whose target is the
 * third argument, are identified as precisely as 4.x builds.
 */
function describeBuild(args: string[]): string {
  return args.filter((a) => /^(platform|tools|target)=/.test(a)).join(' ')
}

/** File extensions collected by {@link createHeaderArchive}. */
export const HEADER_EXTENSIONS = [
  '.glsl',
  '.h',
  '.hh',
  '.hpp',
  '.inc',
  '.inl'
] as const

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
 * Symbolic links are followed: a linked header is archived under its link
 * name and a linked directory is walked. Each real directory is visited once,
 * so link cycles terminate, and dangling links are skipped.
 *
 * Returns the absolute path of the created archive.
 */
export async function createHeaderArchive(sourceDir: string): Promise<string> {
  const absoluteSource = path.resolve(sourceDir)
  core.info(`Collecting header files from: ${absoluteSource}`)

  const headerFiles: string[] = []
  const visited = new Set<string>()

  const isHeader = (name: string): boolean =>
    HEADER_EXTENSIONS.some((ext) => name.endsWith(ext))

  function walkDir(dir: string): void {
    const real = fs.realpathSync(dir)
    if (visited.has(real)) return
    visited.add(real)

    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      let isDir = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        try {
          const target = fs.statSync(fullPath)
          isDir = target.isDirectory()
          isFile = target.isFile()
        } catch {
          continue // dangling link
        }
      }
      if (isDir) {
        walkDir(fullPath)
      } else if (isFile && isHeader(entry.name)) {
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
