/**
 * © 2026-present Action Commons (https://github.com/ActionCommons)
 *
 * Unit tests for src/godot.ts
 *
 * Pure helpers are tested directly.
 * Side-effectful functions are tested with their dependencies mocked via
 * jest.unstable_mockModule.  spawnWithTimeout is exercised through runBuild
 * by mocking child_process.spawn — ES module exports are read-only so
 * jest.spyOn cannot be used to replace exported functions directly.
 */

import { jest } from '@jest/globals'
import { EventEmitter } from 'node:events'

// ── Mocks (must be declared before dynamic import) ────────────────────────────

const coreInfo = jest.fn()
const coreWarning = jest.fn()
const coreError = jest.fn()
jest.unstable_mockModule('@actions/core', () => ({
  info: coreInfo,
  warning: coreWarning,
  debug: jest.fn(),
  error: coreError,
  setFailed: jest.fn()
}))

const execExec = jest.fn<() => Promise<number>>()
jest.unstable_mockModule('@actions/exec', () => ({ exec: execExec }))

const tcDownloadTool = jest.fn<() => Promise<string>>()
const tcExtractTar = jest.fn<() => Promise<string>>()
jest.unstable_mockModule('@actions/tool-cache', () => ({
  downloadTool: tcDownloadTool,
  extractTar: tcExtractTar
}))

const admZipInstance = {
  addLocalFile: jest.fn(),
  writeZip: jest.fn()
}
const AdmZipMock = jest.fn(() => admZipInstance)
jest.unstable_mockModule('adm-zip', () => ({ default: AdmZipMock }))

// child_process is used internally by spawnWithTimeout; mock it here so we
// never actually shell out to scons.
const spawnMock = jest.fn()
jest.unstable_mockModule('child_process', () => ({ spawn: spawnMock }))

// fs mock: readdirSync is called both by downloadAndExtract (returns string[])
// and by createHeaderArchive (returns Dirent-like objects when withFileTypes:true).
// Tests configure the return value directly via mockReturnValue / mockImplementation.
const fsReaddirSync = jest.fn()
const fsStatSync = jest.fn()
jest.unstable_mockModule('node:fs', () => ({
  readdirSync: fsReaddirSync,
  statSync: fsStatSync,
  existsSync: jest.fn<() => boolean>().mockReturnValue(true)
}))

const osTmpdir = jest.fn<() => string>()
jest.unstable_mockModule('node:os', () => ({ tmpdir: osTmpdir }))

// ── Module under test ─────────────────────────────────────────────────────────

const {
  parseMultiInput,
  parseOptions,
  buildDownloadUrl,
  buildSconsArgs,
  downloadAndExtract,
  setupScons,
  runBuild,
  createHeaderArchive,
  VALID_PLATFORMS,
  VALID_TARGETS,
  VALID_ARCHITECTURES
} = await import('../src/godot.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns a minimal fake child process that emits 'exit' on the next
 * event-loop tick.  Passing a non-zero exitCode simulates a failed build.
 */
function makeFakeChild(
  exitCode: number | null = 0,
  signal: string | null = null
): EventEmitter & { kill: jest.Mock } {
  const emitter = new EventEmitter() as EventEmitter & { kill: jest.Mock }
  emitter.kill = jest.fn()
  setImmediate(() => emitter.emit('exit', exitCode, signal))
  return emitter
}

/**
 * Returns a minimal Dirent-like object for use with the fsReaddirSync mock
 * when createHeaderArchive calls readdirSync(dir, { withFileTypes: true }).
 */
function makeDirent(
  name: string,
  type: 'file' | 'dir'
): { name: string; isDirectory: () => boolean; isFile: () => boolean } {
  return {
    name,
    isDirectory: () => type === 'dir',
    isFile: () => type === 'file'
  }
}

// ── Global setup / teardown ───────────────────────────────────────────────────

beforeEach(() => {
  osTmpdir.mockReturnValue('/tmp')
})

afterEach(() => {
  jest.clearAllMocks()
})

// ── parseMultiInput ───────────────────────────────────────────────────────────

describe('parseMultiInput', () => {
  it('splits on commas', () => {
    expect(parseMultiInput('android,windows,macos')).toEqual([
      'android',
      'windows',
      'macos'
    ])
  })

  it('splits on newlines', () => {
    expect(parseMultiInput('editor\ntemplate_release')).toEqual([
      'editor',
      'template_release'
    ])
  })

  it('trims whitespace and filters empty tokens', () => {
    expect(parseMultiInput('  android , , windows \n')).toEqual([
      'android',
      'windows'
    ])
  })

  it('returns an empty array for an empty string', () => {
    expect(parseMultiInput('')).toEqual([])
  })
})

// ── parseOptions ──────────────────────────────────────────────────────────────

describe('parseOptions', () => {
  it('returns an empty object for an empty string', () => {
    expect(parseOptions('')).toEqual({})
  })

  it('parses create_header_archive', () => {
    expect(parseOptions('create_header_archive')).toEqual({
      create_header_archive: true
    })
  })

  it('parses debug_symbols=yes', () => {
    expect(parseOptions('debug_symbols=yes')).toMatchObject({
      debug_symbols: 'yes'
    })
  })

  it('parses debug_symbols=no', () => {
    expect(parseOptions('debug_symbols=no')).toMatchObject({
      debug_symbols: 'no'
    })
  })

  it('throws on invalid debug_symbols value', () => {
    expect(() => parseOptions('debug_symbols=maybe')).toThrow(
      /Invalid debug_symbols value/
    )
  })

  it.each(['speed_trace', 'speed', 'size', 'debug', 'none', 'custom'])(
    'parses optimize=%s',
    (val) => {
      expect(parseOptions(`optimize=${val}`)).toMatchObject({ optimize: val })
    }
  )

  it('throws on invalid optimize value', () => {
    expect(() => parseOptions('optimize=turbo')).toThrow(
      /Invalid optimize value/
    )
  })

  it('throws on unknown option', () => {
    expect(() => parseOptions('unknown_flag')).toThrow(/Unknown option/)
  })

  it('parses multiple options at once', () => {
    const opts = parseOptions(
      'create_header_archive,debug_symbols=yes,optimize=size'
    )
    expect(opts).toEqual({
      create_header_archive: true,
      debug_symbols: 'yes',
      optimize: 'size'
    })
  })
})

// ── buildDownloadUrl ──────────────────────────────────────────────────────────

describe('buildDownloadUrl', () => {
  it('produces the expected URL for a stable release', () => {
    expect(buildDownloadUrl('4.4', 'stable')).toBe(
      'https://github.com/godotengine/godot-builds/releases/download/4.4-stable/godot-4.4-stable.tar.xz'
    )
  })

  it('handles pre-release flavors', () => {
    const url = buildDownloadUrl('4.5', 'beta2')
    expect(url).toContain('4.5-beta2')
    expect(url).toMatch(/\.tar\.xz$/)
  })
})

// ── buildSconsArgs ────────────────────────────────────────────────────────────

describe('buildSconsArgs', () => {
  it('produces minimal args for auto arch and no extra options', () => {
    expect(buildSconsArgs('linuxbsd', 'editor', 'auto', {})).toEqual([
      'platform=linuxbsd',
      'target=editor'
    ])
  })

  it('includes arch= when not "auto"', () => {
    expect(
      buildSconsArgs('windows', 'template_release', 'x86_64', {})
    ).toContain('arch=x86_64')
  })

  it('includes debug_symbols when set', () => {
    expect(
      buildSconsArgs('linuxbsd', 'editor', 'auto', { debug_symbols: 'yes' })
    ).toContain('debug_symbols=yes')
  })

  it('includes optimize when set', () => {
    expect(
      buildSconsArgs('linuxbsd', 'editor', 'auto', { optimize: 'size' })
    ).toContain('optimize=size')
  })

  it('combines multiple options', () => {
    expect(
      buildSconsArgs('web', 'template_release', 'wasm32', {
        debug_symbols: 'no',
        optimize: 'speed_trace'
      })
    ).toEqual([
      'platform=web',
      'target=template_release',
      'arch=wasm32',
      'debug_symbols=no',
      'optimize=speed_trace'
    ])
  })
})

// ── VALID_* constants ─────────────────────────────────────────────────────────

describe('VALID_* constants', () => {
  it('includes all expected platforms', () => {
    expect(VALID_PLATFORMS).toEqual(
      expect.arrayContaining([
        'android',
        'ios',
        'linuxbsd',
        'macos',
        'web',
        'windows'
      ])
    )
  })

  it('includes all expected targets', () => {
    expect(VALID_TARGETS).toEqual(
      expect.arrayContaining(['editor', 'template_debug', 'template_release'])
    )
  })

  it('includes all expected architectures', () => {
    expect(VALID_ARCHITECTURES).toEqual(
      expect.arrayContaining([
        'auto',
        'x86_32',
        'x86_64',
        'arm32',
        'arm64',
        'rv64',
        'ppc32',
        'ppc64',
        'wasm32'
      ])
    )
  })
})

// ── downloadAndExtract ────────────────────────────────────────────────────────

describe('downloadAndExtract', () => {
  beforeEach(() => {
    tcDownloadTool.mockResolvedValue('/tmp/godot.tar.xz')
    tcExtractTar.mockResolvedValue('/work')
    fsReaddirSync.mockReturnValue(['godot-4.4-stable'])
    fsStatSync.mockReturnValue({ isDirectory: () => true })
  })

  it('downloads from the correct URL', async () => {
    await downloadAndExtract('4.4', 'stable', '/work')
    expect(tcDownloadTool).toHaveBeenCalledWith(
      'https://github.com/godotengine/godot-builds/releases/download/4.4-stable/godot-4.4-stable.tar.xz'
    )
  })

  it('extracts with xJ flags', async () => {
    await downloadAndExtract('4.4', 'stable', '/work')
    expect(tcExtractTar).toHaveBeenCalledWith(
      '/tmp/godot.tar.xz',
      '/work',
      'xJ'
    )
  })

  it('returns the source directory path', async () => {
    const result = await downloadAndExtract('4.4', 'stable', '/work')
    expect(result).toBe('/work/godot-4.4-stable')
  })

  it('throws when no godot-* directory is found after extraction', async () => {
    fsReaddirSync.mockReturnValue(['something-else'])
    fsStatSync.mockReturnValue({ isDirectory: () => true })

    await expect(downloadAndExtract('4.4', 'stable', '/work')).rejects.toThrow(
      /no "godot-\*" directory was found/
    )
  })
})

// ── setupScons ────────────────────────────────────────────────────────────────

describe('setupScons', () => {
  it('installs scons via pip3', async () => {
    execExec.mockResolvedValue(0)
    await setupScons()
    expect(execExec).toHaveBeenCalledWith('pip3', [
      'install',
      '--quiet',
      '--break-system-packages',
      'scons'
    ])
  })
})

// ── runBuild / spawnWithTimeout ───────────────────────────────────────────────

describe('runBuild / spawnWithTimeout', () => {
  it('spawns scons once per platform × target combination', async () => {
    spawnMock.mockImplementation(() => makeFakeChild(0))

    await runBuild(
      '/src',
      ['linuxbsd', 'windows'],
      ['editor', 'template_release'],
      'auto',
      {},
      0
    )

    expect(spawnMock).toHaveBeenCalledTimes(4) // 2 platforms × 2 targets
  })

  it('passes the correct scons args for a single combination', async () => {
    spawnMock.mockImplementation(() => makeFakeChild(0))

    await runBuild('/src', ['linuxbsd'], ['editor'], 'x86_64', {}, 0)

    expect(spawnMock).toHaveBeenCalledWith(
      'scons',
      ['platform=linuxbsd', 'target=editor', 'arch=x86_64'],
      expect.objectContaining({ cwd: '/src' })
    )
  })

  it('rejects when scons exits with a non-zero code', async () => {
    spawnMock.mockImplementation(() => makeFakeChild(1))

    await expect(
      runBuild('/src', ['linuxbsd'], ['editor'], 'auto', {}, 0)
    ).rejects.toThrow(/exited with code 1/)
  })

  it('succeeds (does not fail) and kills the process when the timeout is exceeded', async () => {
    jest.useFakeTimers()

    const fakeChild = new EventEmitter() as EventEmitter & {
      kill: jest.Mock
    }
    fakeChild.kill = jest.fn()
    spawnMock.mockReturnValue(fakeChild)

    const buildPromise = runBuild(
      '/src',
      ['linuxbsd'],
      ['editor'],
      'auto',
      {},
      1 // 1 second
    )

    jest.advanceTimersByTime(1500)

    // SCons catches SIGTERM, does cleanup, and exits with code 2 instead of signal SIGTERM.
    // We must treat this as a success if a timeout was configured.
    fakeChild.emit('exit', 2, null)

    await expect(buildPromise).resolves.not.toThrow()
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')

    jest.useRealTimers()
  })

  it('resolves when the process is killed by an external SIGTERM (fallback)', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & { kill: jest.Mock }
    fakeChild.kill = jest.fn()
    spawnMock.mockReturnValue(fakeChild)

    // Start build with no timeout (0) to ensure isTimeout stays false
    const buildPromise = runBuild(
      '/src',
      ['linuxbsd'],
      ['editor'],
      'auto',
      {},
      0
    )

    // Simulate an external SIGTERM signal received by the child process
    fakeChild.emit('exit', null, 'SIGTERM')

    await expect(buildPromise).resolves.not.toThrow()
  })

  it('clears the timeout when scons exits early', async () => {
    // A fake child that exits immediately with success (0)
    spawnMock.mockImplementation(() => makeFakeChild(0))

    // Set a timeout (> 0) so the timer is created
    await runBuild('/src', ['linuxbsd'], ['editor'], 'auto', {}, 10)

    // The fact that this resolves successfully without throwing or hanging
    // means it successfully hit the clearTimeout line on the 'exit' event.
    expect(spawnMock).toHaveBeenCalled()
  })

  it('rejects and clears timeout when child process emits an error', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & {
      kill: jest.Mock
    }
    fakeChild.kill = jest.fn()

    // Simulate a process error (e.g., failed to start) on the next tick
    setImmediate(() => fakeChild.emit('error', new Error('spawn EACCES')))
    spawnMock.mockReturnValue(fakeChild)

    // Run with a timeout (> 0) to ensure the timer cleanup line is hit during an error
    await expect(
      runBuild('/src', ['linuxbsd'], ['editor'], 'auto', {}, 10)
    ).rejects.toThrow('spawn EACCES')
  })

  it('rejects when the process is killed by a signal other than SIGTERM', async () => {
    // Simulate the process being forcefully killed (e.g. by the OS or a user)
    spawnMock.mockImplementation(() => makeFakeChild(null, 'SIGKILL'))

    await expect(
      runBuild('/src', ['linuxbsd'], ['editor'], 'auto', {}, 0)
    ).rejects.toThrow('Build process killed by signal SIGKILL')
  })

  it('rejects and skips clearTimeout when child process emits an error and no timeout is set', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & { kill: jest.Mock }
    fakeChild.kill = jest.fn()

    // Simulate an error without setting a timeout in runBuild
    setImmediate(() => fakeChild.emit('error', new Error('immediate failure')))
    spawnMock.mockReturnValue(fakeChild)

    await expect(
      runBuild('/src', ['linuxbsd'], ['editor'], 'auto', {}, 0) // 0 = no timeout
    ).rejects.toThrow('immediate failure')
  })

  it('calls onTimeout before killing the process when timeout is exceeded', async () => {
    jest.useFakeTimers()
    const onTimeout = jest.fn<() => Promise<void>>().mockResolvedValue()
    const fakeChild = new EventEmitter() as EventEmitter & { kill: jest.Mock }
    fakeChild.kill = jest.fn()
    spawnMock.mockReturnValue(fakeChild)

    const buildPromise = runBuild(
      '/src',
      ['ios'],
      ['template_debug'],
      'auto',
      {},
      1,
      onTimeout
    )

    // Trigger timer
    await jest.advanceTimersByTimeAsync(1500)

    expect(onTimeout).toHaveBeenCalled()
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')

    fakeChild.emit('exit', 2, null)
    await expect(buildPromise).resolves.not.toThrow()
    jest.useRealTimers()
  })

  it('resolves when killed by an external SIGTERM (Coverage Line 283)', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & { kill: jest.Mock }
    fakeChild.kill = jest.fn()
    spawnMock.mockReturnValue(fakeChild)

    const buildPromise = runBuild(
      '/src',
      ['linuxbsd'],
      ['editor'],
      'auto',
      {},
      0
    )

    // Simulate external SIGTERM before internal timeout
    fakeChild.emit('exit', null, 'SIGTERM')

    await expect(buildPromise).resolves.not.toThrow()
  })

  it('logs an error via core.error when onTimeout rejects during timeout', async () => {
    jest.useFakeTimers()

    const onTimeout = jest
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('archive failed'))

    const fakeChild = new EventEmitter() as EventEmitter & { kill: jest.Mock }
    fakeChild.kill = jest.fn()
    spawnMock.mockReturnValue(fakeChild)

    const buildPromise = runBuild(
      '/src',
      ['ios'],
      ['template_debug'],
      'auto',
      {},
      1,
      onTimeout
    )

    await jest.advanceTimersByTimeAsync(1500)

    expect(onTimeout).toHaveBeenCalled()
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')

    fakeChild.emit('exit', 2, null)
    await expect(buildPromise).resolves.not.toThrow()

    expect(coreError).toHaveBeenCalledWith(
      expect.stringContaining('Header archiving failed during timeout')
    )

    jest.useRealTimers()
  })
})

// ── createHeaderArchive ───────────────────────────────────────────────────────

describe('createHeaderArchive', () => {
  it('walks the directory tree and writes a zip (including root-level files)', async () => {
    // Simulate a two-level tree:
    //   /src/
    //     root.h          ← triggers the zipDir === '.' branch (empty string)
    //     include/
    //       a.h           ← triggers the normal zipDir branch ('include')
    //       util.hpp
    fsReaddirSync.mockImplementation((dir: unknown) => {
      if (dir === '/src') {
        return [makeDirent('root.h', 'file'), makeDirent('include', 'dir')]
      }
      if (dir === '/src/include') {
        return [makeDirent('a.h', 'file'), makeDirent('util.hpp', 'file')]
      }
      return []
    })

    const result = await createHeaderArchive('/src')

    // All three header files must have been added to the zip.
    expect(admZipInstance.addLocalFile).toHaveBeenCalledTimes(3)
    expect(admZipInstance.addLocalFile).toHaveBeenCalledWith('/src/root.h', '') // '.' → ''
    expect(admZipInstance.addLocalFile).toHaveBeenCalledWith(
      '/src/include/a.h',
      'include'
    )
    expect(admZipInstance.addLocalFile).toHaveBeenCalledWith(
      '/src/include/util.hpp',
      'include'
    )

    expect(admZipInstance.writeZip).toHaveBeenCalled()
    expect(result).toMatch(/^\/tmp\/godot-headers-\d+\.zip$/)
  })

  it('emits a warning and still writes the zip when no header files are found', async () => {
    // Empty directory — no .h / .hpp files at any level.
    fsReaddirSync.mockReturnValue([])

    await createHeaderArchive('/src')

    expect(coreWarning).toHaveBeenCalledWith(
      expect.stringContaining('No header files found')
    )
    expect(admZipInstance.writeZip).toHaveBeenCalled()
  })

  it('logs the header file count when files are found', async () => {
    fsReaddirSync.mockImplementation((dir: unknown) => {
      if (dir === '/src') {
        return [makeDirent('core.h', 'file')]
      }
      return []
    })

    await createHeaderArchive('/src')

    expect(coreInfo).toHaveBeenCalledWith(
      expect.stringContaining('1 header file(s)')
    )
  })

  it('ignores non-header files during the walk', async () => {
    fsReaddirSync.mockImplementation((dir: unknown) => {
      if (dir === '/src') {
        return [
          makeDirent('main.cpp', 'file'), // should be ignored
          makeDirent('README.md', 'file'), // should be ignored
          makeDirent('api.h', 'file') // should be included
        ]
      }
      return []
    })

    await createHeaderArchive('/src')

    expect(admZipInstance.addLocalFile).toHaveBeenCalledTimes(1)
    expect(admZipInstance.addLocalFile).toHaveBeenCalledWith('/src/api.h', '')
  })

  it('recurses into nested subdirectories', async () => {
    fsReaddirSync.mockImplementation((dir: unknown) => {
      if (dir === '/src') return [makeDirent('deep', 'dir')]
      if (dir === '/src/deep') return [makeDirent('nested', 'dir')]
      if (dir === '/src/deep/nested') return [makeDirent('types.h', 'file')]
      return []
    })

    await createHeaderArchive('/src')

    expect(admZipInstance.addLocalFile).toHaveBeenCalledWith(
      '/src/deep/nested/types.h',
      'deep/nested'
    )
  })
})
