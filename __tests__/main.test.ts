/**
 * © 2026-present Action Commons (https://github.com/ActionCommons)
 *
 * Unit tests for src/main.ts
 *
 * @actions/core and src/godot.ts are mocked so tests exercise only the
 * orchestration logic in main.ts (input validation, output setting, error
 * handling) without touching the filesystem or running real processes.
 */

import { jest } from '@jest/globals'
import * as path from 'node:path'
import * as core from '../__fixtures__/core.js'
import * as godot from '../__fixtures__/godot.js'

// Mocks must be declared before the module under test is imported.
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('../src/godot.js', () => godot)

// Mock node:fs so mkdtempSync / existsSync never touch the real filesystem.
const fsMkdtempSync = jest.fn<() => string>()
const fsExistsSync = jest.fn<() => boolean>()
const fsMkdirSync = jest.fn()
jest.unstable_mockModule('node:fs', () => ({
  mkdtempSync: fsMkdtempSync,
  existsSync: fsExistsSync,
  mkdirSync: fsMkdirSync
}))

// Mock node:os so tmpdir() is deterministic.
jest.unstable_mockModule('node:os', () => ({
  tmpdir: () => '/tmp'
}))

// Dynamic import after mocks.
const { run } = await import('../src/main.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid inputs — each test overrides only what differs. */
const DEFAULT_INPUTS: Record<string, string> = {
  version: '4.4',
  flavor: 'stable',
  directory: '/work',
  timeout: '0',
  platform: 'linuxbsd',
  target: 'editor',
  architecture: 'auto',
  options: ''
}

/** Configures core.getInput with DEFAULT_INPUTS merged with `overrides`. */
function setInputs(overrides: Record<string, string> = {}): void {
  const inputs = { ...DEFAULT_INPUTS, ...overrides }
  core.getInput.mockImplementation((name: string) => inputs[name] ?? '')
}

/** Asserts the run failed with `message` before any side effect happened. */
function expectFailedBeforeSideEffects(message: string): void {
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining(message))
  expect(godot.downloadAndExtract).not.toHaveBeenCalled()
  expect(godot.setupScons).not.toHaveBeenCalled()
  expect(godot.runBuild).not.toHaveBeenCalled()
  expect(core.setOutput).not.toHaveBeenCalledWith(
    'directory',
    expect.anything()
  )
  expect(fsMkdtempSync).not.toHaveBeenCalled()
  expect(fsMkdirSync).not.toHaveBeenCalled()
}

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  setInputs()

  // Restore fs mock return values after each jest.resetAllMocks().
  fsMkdtempSync.mockReturnValue('/tmp/godot-build-xyz')
  fsExistsSync.mockReturnValue(true)

  // Side-effectful godot functions resolve by default.
  godot.downloadAndExtract.mockResolvedValue('/work/godot-4.4-stable')
  godot.setupScons.mockResolvedValue(undefined)
  godot.runBuild.mockResolvedValue(undefined)
  godot.createHeaderArchive.mockResolvedValue('/tmp/godot-headers-1234.zip')
})

afterEach(() => {
  jest.resetAllMocks()
})

// ── Happy-path tests ──────────────────────────────────────────────────────────

describe('main.ts – happy path', () => {
  it('always sets the "directory" output', async () => {
    await run()
    expect(core.setOutput).toHaveBeenCalledWith('directory', '/work')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('calls downloadAndExtract with version and flavor', async () => {
    await run()
    expect(godot.downloadAndExtract).toHaveBeenCalledWith(
      '4.4',
      'stable',
      '/work'
    )
  })

  it('calls setupScons with the detected major version', async () => {
    await run()
    expect(godot.setupScons).toHaveBeenCalledTimes(1)
    expect(godot.setupScons).toHaveBeenCalledWith(4)
  })

  it('calls runBuild with parsed platforms and targets', async () => {
    setInputs({
      platform: 'linuxbsd,windows',
      target: 'editor\ntemplate_release'
    })

    await run()

    expect(godot.runBuild).toHaveBeenCalledWith(
      '/work/godot-4.4-stable',
      ['linuxbsd', 'windows'],
      ['editor', 'template_release'],
      'auto',
      {},
      0,
      expect.any(Function),
      4
    )
  })

  it('does NOT set header_archive output when create_header_archive is absent', async () => {
    await run()
    expect(godot.createHeaderArchive).not.toHaveBeenCalled()
    expect(core.setOutput).not.toHaveBeenCalledWith(
      'header_archive',
      expect.anything()
    )
  })

  it('creates and outputs the header archive when option is set', async () => {
    setInputs({ options: 'create_header_archive' })

    await run()

    expect(godot.createHeaderArchive).toHaveBeenCalledWith(
      '/work/godot-4.4-stable'
    )
    expect(core.setOutput).toHaveBeenCalledWith(
      'header_archive',
      '/tmp/godot-headers-1234.zip'
    )
    expect(core.info).toHaveBeenCalledWith(
      'Header archive secured: /tmp/godot-headers-1234.zip'
    )
  })

  it('creates a temp directory when no directory input is given', async () => {
    setInputs({ directory: '' })
    godot.downloadAndExtract.mockResolvedValue(
      '/tmp/godot-build-xyz/godot-4.4-stable'
    )

    await run()

    expect(fsMkdtempSync).toHaveBeenCalledWith('/tmp/godot-build-')
    expect(core.setOutput).toHaveBeenCalledWith(
      'directory',
      '/tmp/godot-build-xyz'
    )
  })

  it('passes timeout in seconds to runBuild', async () => {
    setInputs({ timeout: '120' })

    await run()

    expect(godot.runBuild).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.any(Array),
      expect.any(String),
      expect.any(Object),
      120,
      expect.any(Function),
      4
    )
  })

  it('accepts the largest timeout that fits in a Node.js timer', async () => {
    setInputs({ timeout: '2147483' })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(godot.runBuild.mock.calls[0][5]).toBe(2147483)
  })

  it('passes architecture to runBuild', async () => {
    setInputs({ architecture: 'x86_64' })

    await run()

    expect(godot.runBuild.mock.calls[0][3]).toBe('x86_64')
  })

  it('does not create the working directory when it already exists', async () => {
    fsExistsSync.mockReturnValue(true)
    setInputs({ directory: '/custom/build/dir' })

    await run()

    expect(fsExistsSync).toHaveBeenCalledWith('/custom/build/dir')
    expect(fsMkdirSync).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith(
      'Working directory (absolute): /custom/build/dir'
    )
  })

  it('creates the working directory if it does not exist', async () => {
    fsExistsSync.mockReturnValue(false)
    setInputs({ directory: '/custom/build/dir' })

    await run()

    expect(fsMkdirSync).toHaveBeenCalledWith('/custom/build/dir', {
      recursive: true
    })
  })

  it('deduplicates repeated platforms and targets', async () => {
    setInputs({
      platform: 'linuxbsd, windows, linuxbsd',
      target: 'editor\neditor\ntemplate_release'
    })

    await run()

    expect(godot.runBuild.mock.calls[0][1]).toEqual(['linuxbsd', 'windows'])
    expect(godot.runBuild.mock.calls[0][2]).toEqual([
      'editor',
      'template_release'
    ])
  })

  it.each(['dev6', 'alpha1', 'beta2', 'rc1'])(
    'accepts the prerelease flavor %s for 4.x',
    async (flavor) => {
      setInputs({ version: '4.6', flavor })

      await run()

      expect(core.setFailed).not.toHaveBeenCalled()
      expect(godot.downloadAndExtract).toHaveBeenCalledWith(
        '4.6',
        flavor,
        '/work'
      )
    }
  )

  it('does not warn about the version for Godot 4.x', async () => {
    setInputs({ version: '4.0' })

    await run()

    expect(core.warning).not.toHaveBeenCalled()
  })

  it.each(['3.5', '3.5.3'])(
    'does not warn for %s, the oldest tested 3.x minor (boundary)',
    async (version) => {
      setInputs({ version })

      await run()

      expect(core.warning).not.toHaveBeenCalled()
      expect(core.setFailed).not.toHaveBeenCalled()
    }
  )

  it('marks version, platform and target as required inputs', async () => {
    await run()

    for (const name of ['version', 'platform', 'target']) {
      expect(core.getInput).toHaveBeenCalledWith(name, { required: true })
    }
    for (const name of [
      'flavor',
      'directory',
      'timeout',
      'architecture',
      'options'
    ]) {
      expect(core.getInput).toHaveBeenCalledWith(name)
    }
  })

  it('resolves a relative directory input against the current working directory', async () => {
    setInputs({ directory: './custom_godot_source' })
    const expected = path.resolve('./custom_godot_source')

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('directory', expected)
    expect(godot.downloadAndExtract).toHaveBeenCalledWith(
      '4.4',
      'stable',
      expected
    )
    expect(fsMkdtempSync).not.toHaveBeenCalled()
  })
})

// ── Godot 3.x integration ─────────────────────────────────────────────────────

describe('main.ts – Godot 3.x', () => {
  beforeEach(() => {
    godot.downloadAndExtract.mockResolvedValue('/work/godot-3.6-stable')
  })

  it('detects Godot 3.x from the version input and passes it through', async () => {
    setInputs({ version: '3.6' })

    await run()

    expect(core.info).toHaveBeenCalledWith('Detected Godot major version: 3.x')
    expect(godot.downloadAndExtract).toHaveBeenCalledWith(
      '3.6',
      'stable',
      '/work'
    )
    expect(godot.setupScons).toHaveBeenCalledWith(3)
    expect(godot.runBuild).toHaveBeenCalledWith(
      '/work/godot-3.6-stable',
      ['linuxbsd'],
      ['editor'],
      'auto',
      {},
      0,
      expect.any(Function),
      3
    )
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('passes an explicit architecture through for translation', async () => {
    setInputs({
      version: '3.6',
      platform: 'android',
      target: 'template_release',
      architecture: 'arm64'
    })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(godot.runBuild).toHaveBeenCalledWith(
      '/work/godot-3.6-stable',
      ['android'],
      ['template_release'],
      'arm64',
      {},
      0,
      expect.any(Function),
      3
    )
  })

  it('builds multiple platforms and targets in one run', async () => {
    setInputs({
      version: '3.5.3',
      platform: 'linuxbsd, windows\nmacos',
      target: 'template_debug, template_release',
      architecture: 'x86_64'
    })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(godot.runBuild.mock.calls[0].slice(1, 4)).toEqual([
      ['linuxbsd', 'windows', 'macos'],
      ['template_debug', 'template_release'],
      'x86_64'
    ])
    expect(godot.runBuild.mock.calls[0][7]).toBe(3)
  })

  it('creates the header archive for a 3.x source tree', async () => {
    setInputs({ version: '3.6', options: 'create_header_archive' })

    await run()

    expect(godot.createHeaderArchive).toHaveBeenCalledTimes(1)
    expect(godot.createHeaderArchive).toHaveBeenCalledWith(
      '/work/godot-3.6-stable'
    )
    expect(core.setOutput).toHaveBeenCalledWith(
      'header_archive',
      '/tmp/godot-headers-1234.zip'
    )
  })

  it.each(['rc1', 'beta3'])(
    'downloads the 3.x prerelease flavor %s',
    async (flavor) => {
      setInputs({ version: '3.6', flavor })

      await run()

      expect(core.setFailed).not.toHaveBeenCalled()
      expect(godot.downloadAndExtract).toHaveBeenCalledWith(
        '3.6',
        flavor,
        '/work'
      )
      expect(godot.setupScons).toHaveBeenCalledWith(3)
    }
  )

  it.each(['3.0', '3.4', '3.4.5'])(
    'warns (but continues) for the untested 3.x release %s',
    async (version) => {
      setInputs({ version })

      await run()

      expect(core.warning).toHaveBeenCalledWith(
        `Godot ${version} is older than 3.5, the oldest 3.x release this ` +
          `action is tested with. The build may fail with the toolchains ` +
          `available on current runners.`
      )
      expect(core.setFailed).not.toHaveBeenCalled()
      expect(godot.runBuild).toHaveBeenCalled()
    }
  )

  it.each([
    [
      { options: 'generate_bundle=yes', platform: 'macos' },
      'generate_bundle is only supported'
    ],
    [
      { options: 'optimize=speed_trace' },
      'optimize=speed_trace is not supported when building Godot 3.x'
    ],
    [
      { architecture: 'rv64' },
      'Architecture "rv64" is not supported for platform "linuxbsd" when building Godot 3.x'
    ],
    [
      { platform: 'linuxbsd, web', architecture: 'x86_64' },
      'Architecture "x86_64" is not supported for platform "web"'
    ],
    [
      { platform: 'android' },
      'Target "editor" is not available for platform "android" when building Godot 3.x'
    ],
    [
      { platform: 'ios' },
      'Target "editor" is not available for platform "ios"'
    ],
    [
      { options: 'ios_simulator=yes', target: 'template_debug' },
      'Option "ios_simulator" is only supported for platform(s) ios'
    ]
  ])('rejects %j before any side effect', async (overrides, message) => {
    setInputs({ version: '3.6', ...overrides })

    await run()

    expect(core.setFailed).toHaveBeenCalledTimes(1)
    expectFailedBeforeSideEffects(message)
  })
})

// ── Validation error tests ────────────────────────────────────────────────────

describe('main.ts – input validation', () => {
  it.each([
    [
      { platform: 'dos' },
      'Invalid platform: "dos". Must be one of: android, ios, linuxbsd, macos, web, windows.'
    ],
    [
      { target: 'Editor' },
      'Invalid target: "Editor". Must be one of: editor, template_debug, template_release.'
    ],
    [
      { architecture: 'mips' },
      'Invalid architecture: "mips". Must be one of: auto, x86_32, x86_64, arm32, arm64, rv64, ppc32, ppc64, wasm32.'
    ]
  ])(
    'reports the full list of valid values for %j',
    async (overrides, message) => {
      setInputs(overrides)

      await run()

      expect(core.setFailed).toHaveBeenCalledWith(message)
    }
  )

  it.each([
    [{ version: '2.1.6' }, 'Unsupported Godot major version: 2'],
    [{ version: '5.0' }, 'Unsupported Godot major version: 5'],
    [{ version: 'latest' }, 'Invalid version: "latest"'],
    [{ version: '4.4.0' }, 'use "4.4"'],
    [{ version: '04.4' }, 'Invalid version: "04.4"'],
    [{ flavor: 'Stable' }, 'Invalid flavor: "Stable"'],
    [{ flavor: 'rc1/../x' }, 'Invalid flavor: "rc1/../x"'],
    [{ flavor: 'beta-1' }, 'Invalid flavor: "beta-1"'],
    [{ platform: 'dos' }, 'Invalid platform: "dos"'],
    [{ platform: 'LinuxBSD' }, 'Invalid platform: "LinuxBSD"'],
    [{ platform: 'linuxbsd, Windows' }, 'Invalid platform: "Windows"'],
    [{ target: 'release_template' }, 'Invalid target: "release_template"'],
    [{ target: 'Editor' }, 'Invalid target: "Editor"'],
    [{ architecture: 'mips' }, 'Invalid architecture: "mips"'],
    [{ architecture: 'X86_64' }, 'Invalid architecture: "X86_64"'],
    [{ timeout: '-5' }, 'Invalid timeout value: "-5"'],
    [{ timeout: 'abc' }, 'Invalid timeout value: "abc"'],
    [{ timeout: '1.5' }, 'Invalid timeout value: "1.5"'],
    [{ timeout: '10abc' }, 'Invalid timeout value: "10abc"'],
    [{ timeout: '2147484' }, 'Must not exceed 2147483 seconds'],
    [{ options: 'unknown_flag' }, 'Unknown option: "unknown_flag"'],
    [
      { options: 'optimize=speed,optimize=size' },
      'Conflicting values for option "optimize"'
    ],
    [{ platform: ' , \n' }, 'At least one platform must be specified.'],
    [{ target: ',' }, 'At least one target must be specified.'],
    [
      { architecture: 'wasm32' },
      'Architecture "wasm32" is not supported for platform "linuxbsd" when building Godot 4.x'
    ],
    [
      { platform: 'web', architecture: 'x86_64' },
      'Architecture "x86_64" is not supported for platform "web" when building Godot 4.x'
    ],
    [
      { platform: 'ios' },
      'Target "editor" is not available for platform "ios" when building Godot 4.x'
    ],
    [
      { options: 'ios_simulator=yes' },
      'Option "ios_simulator" is only supported for platform(s) ios, but "linuxbsd" was requested.'
    ],
    [
      { options: 'generate_bundle=yes', platform: 'windows' },
      'Option "generate_bundle" is only supported for platform(s) macos, ios, but "windows" was requested.'
    ]
  ])('fails for %j before any side effect', async (overrides, message) => {
    setInputs(overrides)

    await run()

    expect(core.setFailed).toHaveBeenCalledTimes(1)
    expectFailedBeforeSideEffects(message)
  })

  it('accepts the Android editor on 4.x', async () => {
    setInputs({ platform: 'android', architecture: 'arm64' })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('accepts platform-specific options on their platforms for 4.x', async () => {
    setInputs({
      platform: 'ios',
      target: 'template_debug',
      options: 'ios_simulator=yes, generate_bundle=yes'
    })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(godot.runBuild.mock.calls[0][4]).toEqual({
      ios_simulator: 'yes',
      generate_bundle: 'yes'
    })
  })
})

// ── Timeout callback end to end ───────────────────────────────────────────────

describe('main.ts – timeout callback', () => {
  /**
   * Fake runBuild that mirrors the real loop: it "spawns" each combination in
   * order and, when the first one hits the timeout, invokes onTimeout (with the
   * same error handling as the real implementation) and stops the loop.
   */
  function fakeRunBuildTimingOutOnFirst(spawned: string[]) {
    return async (
      _src: string,
      platforms: string[],
      targets: string[],
      _arch: string,
      _opts: unknown,
      _timeout: number,
      onTimeout?: () => Promise<void>
    ): Promise<void> => {
      for (const p of platforms) {
        for (const t of targets) {
          spawned.push(`${p}:${t}`)
          try {
            await onTimeout?.()
          } catch {
            // the real runBuild logs and continues to kill the process
          }
          return
        }
      }
    }
  }

  it('archives headers exactly once and never spawns the second combination', async () => {
    setInputs({
      timeout: '40',
      target: 'template_debug, template_release',
      options: 'create_header_archive'
    })
    const spawned: string[] = []
    godot.runBuild.mockImplementation(fakeRunBuildTimingOutOnFirst(spawned))

    await run()

    expect(spawned).toEqual(['linuxbsd:template_debug'])
    expect(godot.createHeaderArchive).toHaveBeenCalledTimes(1)
    const archiveOutputs = core.setOutput.mock.calls.filter(
      ([name]) => name === 'header_archive'
    )
    expect(archiveOutputs).toEqual([
      ['header_archive', '/tmp/godot-headers-1234.zip']
    ])
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('retries the archive after the build when it failed during the timeout', async () => {
    setInputs({
      timeout: '40',
      target: 'template_debug, template_release',
      options: 'create_header_archive'
    })
    const spawned: string[] = []
    godot.runBuild.mockImplementation(fakeRunBuildTimingOutOnFirst(spawned))
    godot.createHeaderArchive
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce('/tmp/godot-headers-retry.zip')

    await run()

    expect(spawned).toHaveLength(1)
    expect(godot.createHeaderArchive).toHaveBeenCalledTimes(2)
    expect(core.setOutput).toHaveBeenCalledWith(
      'header_archive',
      '/tmp/godot-headers-retry.zip'
    )
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('the timeout callback is a no-op without create_header_archive', async () => {
    setInputs({ timeout: '40' })
    const spawned: string[] = []
    godot.runBuild.mockImplementation(fakeRunBuildTimingOutOnFirst(spawned))

    await run()

    expect(godot.createHeaderArchive).not.toHaveBeenCalled()
  })
})

// ── Error propagation ─────────────────────────────────────────────────────────

describe('main.ts – error propagation', () => {
  it('calls setFailed when downloadAndExtract throws', async () => {
    godot.downloadAndExtract.mockRejectedValue(new Error('network error'))

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('network error')
  })

  it('still exposes the directory output when the download fails', async () => {
    // The working directory exists at that point, so later steps can inspect
    // or clean it; the output is set before the download starts.
    godot.downloadAndExtract.mockRejectedValue(new Error('network error'))

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('directory', '/work')
    expect(core.setOutput).not.toHaveBeenCalledWith(
      'header_archive',
      expect.anything()
    )
  })

  it('calls setFailed when setupScons throws', async () => {
    godot.setupScons.mockRejectedValue(new Error('pip3 not found'))

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('pip3 not found')
  })

  it('calls setFailed when runBuild throws (e.g. build failure)', async () => {
    godot.runBuild.mockRejectedValue(new Error('scons: *** Error 1'))

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('scons: *** Error 1')
  })

  it('calls setFailed when createHeaderArchive throws', async () => {
    setInputs({ options: 'create_header_archive' })
    godot.createHeaderArchive.mockRejectedValue(new Error('disk full'))

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('disk full')
  })

  it('calls setFailed when a non-Error value is thrown (regression: D2)', async () => {
    godot.downloadAndExtract.mockImplementation(() => {
      throw 'something went wrong without an error object'
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      'something went wrong without an error object'
    )
  })

  it('stringifies non-string, non-Error rejections', async () => {
    godot.runBuild.mockRejectedValue(42)

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('42')
  })

  it('uses default values for optional inputs when they are empty', async () => {
    core.getInput.mockImplementation(
      (name: string) =>
        ({ platform: 'linuxbsd', target: 'editor', version: '4.4' })[name] ?? ''
    )

    await run()

    expect(godot.downloadAndExtract).toHaveBeenCalledWith(
      '4.4',
      'stable',
      expect.any(String)
    )
    expect(godot.runBuild).toHaveBeenCalledWith(
      expect.any(String),
      ['linuxbsd'],
      ['editor'],
      'auto',
      {},
      0,
      expect.any(Function),
      4
    )
  })
})
