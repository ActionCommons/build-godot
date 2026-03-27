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

/** Minimal valid inputs — individual tests override as needed. */
function setDefaultInputs(): void {
  core.getInput.mockImplementation((name: string) => {
    const inputs: Record<string, string> = {
      version: '4.4',
      flavor: 'stable',
      directory: '/work',
      timeout: '0',
      platform: 'linuxbsd',
      target: 'editor',
      architecture: 'auto',
      options: ''
    }
    return inputs[name] ?? ''
  })
}

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  setDefaultInputs()

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
  })

  it('calls downloadAndExtract with version and flavor', async () => {
    await run()
    expect(godot.downloadAndExtract).toHaveBeenCalledWith(
      '4.4',
      'stable',
      '/work'
    )
  })

  it('calls setupScons', async () => {
    await run()
    expect(godot.setupScons).toHaveBeenCalledTimes(1)
  })

  it('calls runBuild with parsed platforms and targets', async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === 'platform') return 'linuxbsd,windows'
      if (name === 'target') return 'editor\ntemplate_release'
      return (
        {
          version: '4.4',
          flavor: 'stable',
          directory: '/work',
          timeout: '0',
          architecture: 'auto',
          options: ''
        }[name] ?? ''
      )
    })

    await run()

    expect(godot.runBuild).toHaveBeenCalledWith(
      '/work/godot-4.4-stable',
      ['linuxbsd', 'windows'],
      ['editor', 'template_release'],
      'auto',
      {},
      0,
      expect.any(Function)
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
    core.getInput.mockImplementation((name: string) => {
      if (name === 'options') return 'create_header_archive'
      return (
        {
          version: '4.4',
          flavor: 'stable',
          directory: '/work',
          timeout: '0',
          platform: 'linuxbsd',
          target: 'editor',
          architecture: 'auto'
        }[name] ?? ''
      )
    })

    await run()

    expect(godot.createHeaderArchive).toHaveBeenCalledWith(
      '/work/godot-4.4-stable'
    )
    expect(core.setOutput).toHaveBeenCalledWith(
      'header_archive',
      '/tmp/godot-headers-1234.zip'
    )
  })

  it('creates a temp directory when no directory input is given', async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === 'directory') return ''
      return (
        {
          version: '4.4',
          flavor: 'stable',
          timeout: '0',
          platform: 'linuxbsd',
          target: 'editor',
          architecture: 'auto',
          options: ''
        }[name] ?? ''
      )
    })
    // Ensure mock return values are set for this test (may have been cleared).
    fsMkdtempSync.mockReturnValue('/tmp/godot-build-xyz')
    fsExistsSync.mockReturnValue(true)
    godot.downloadAndExtract.mockResolvedValue(
      '/tmp/godot-build-xyz/godot-4.4-stable'
    )

    await run()

    expect(fsMkdtempSync).toHaveBeenCalled()
    expect(core.setOutput).toHaveBeenCalledWith(
      'directory',
      '/tmp/godot-build-xyz'
    )
  })

  it('passes timeout in seconds to runBuild', async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === 'timeout') return '120'
      return (
        {
          version: '4.4',
          flavor: 'stable',
          directory: '/work',
          platform: 'linuxbsd',
          target: 'editor',
          architecture: 'auto',
          options: ''
        }[name] ?? ''
      )
    })

    await run()

    expect(godot.runBuild).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.any(Array),
      expect.any(String),
      expect.any(Object),
      120,
      expect.any(Function)
    )
  })

  it('passes architecture to runBuild', async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === 'architecture') return 'x86_64'
      return (
        {
          version: '4.4',
          flavor: 'stable',
          directory: '/work',
          timeout: '0',
          platform: 'linuxbsd',
          target: 'editor',
          options: ''
        }[name] ?? ''
      )
    })

    await run()

    expect(godot.runBuild).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.any(Array),
      'x86_64',
      expect.any(Object),
      expect.any(Number),
      expect.any(Function)
    )
  })

  it('creates the working directory if it does not exist', async () => {
    // Override the default mock to pretend the directory doesn't exist yet
    fsExistsSync.mockReturnValue(false)

    core.getInput.mockImplementation((name: string) => {
      if (name === 'directory') return '/custom/build/dir'
      return (
        {
          version: '4.4',
          flavor: 'stable',
          platform: 'linuxbsd',
          target: 'editor',
          architecture: 'auto',
          options: ''
        }[name] ?? ''
      )
    })

    await run()

    // Assert that we attempted to create the directory recursively
    expect(fsMkdirSync).toHaveBeenCalledWith('/custom/build/dir', {
      recursive: true
    })
  })
})

// ── Validation error tests ────────────────────────────────────────────────────

describe('main.ts – input validation', () => {
  it('calls setFailed for an invalid platform', async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === 'platform') return 'dos'
      return (
        {
          version: '4.4',
          flavor: 'stable',
          directory: '/work',
          timeout: '0',
          target: 'editor',
          architecture: 'auto',
          options: ''
        }[name] ?? ''
      )
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Invalid platform: "dos"')
    )
  })

  it('calls setFailed for an invalid target', async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === 'target') return 'release_template'
      return (
        {
          version: '4.4',
          flavor: 'stable',
          directory: '/work',
          timeout: '0',
          platform: 'linuxbsd',
          architecture: 'auto',
          options: ''
        }[name] ?? ''
      )
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Invalid target: "release_template"')
    )
  })

  it('calls setFailed for an invalid architecture', async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === 'architecture') return 'mips'
      return (
        {
          version: '4.4',
          flavor: 'stable',
          directory: '/work',
          timeout: '0',
          platform: 'linuxbsd',
          target: 'editor',
          options: ''
        }[name] ?? ''
      )
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Invalid architecture: "mips"')
    )
  })

  it('calls setFailed for a negative timeout', async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === 'timeout') return '-5'
      return (
        {
          version: '4.4',
          flavor: 'stable',
          directory: '/work',
          platform: 'linuxbsd',
          target: 'editor',
          architecture: 'auto',
          options: ''
        }[name] ?? ''
      )
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Invalid timeout value')
    )
  })

  it('calls setFailed for a non-numeric timeout', async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === 'timeout') return 'forever'
      return (
        {
          version: '4.4',
          flavor: 'stable',
          directory: '/work',
          platform: 'linuxbsd',
          target: 'editor',
          architecture: 'auto',
          options: ''
        }[name] ?? ''
      )
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Invalid timeout value')
    )
  })

  it('calls setFailed for invalid options', async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === 'options') return 'turbo_mode=yes'
      return (
        {
          version: '4.4',
          flavor: 'stable',
          directory: '/work',
          timeout: '0',
          platform: 'linuxbsd',
          target: 'editor',
          architecture: 'auto'
        }[name] ?? ''
      )
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Unknown option')
    )
  })

  it('calls setFailed when no platforms are specified', async () => {
    core.getInput.mockImplementation((name: string) => {
      // Simulate an empty string or whitespace for platform
      if (name === 'platform') return '   '
      return (
        {
          version: '4.4',
          target: 'editor'
        }[name] ?? ''
      )
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('At least one platform must be specified.')
    )
  })

  it('calls setFailed when no targets are specified', async () => {
    core.getInput.mockImplementation((name: string) => {
      // Simulate an empty string or whitespace for target
      if (name === 'target') return ''
      return (
        {
          version: '4.4',
          platform: 'linuxbsd'
        }[name] ?? ''
      )
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('At least one target must be specified.')
    )
  })
})

// ── Downstream error propagation ──────────────────────────────────────────────

describe('main.ts – error propagation', () => {
  it('calls setFailed when downloadAndExtract throws', async () => {
    godot.downloadAndExtract.mockRejectedValue(new Error('network error'))

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('network error')
  })

  it('calls setFailed when setupScons throws', async () => {
    godot.setupScons.mockRejectedValue(new Error('pip3 not found'))

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('pip3 not found')
  })

  it('calls setFailed when runBuild throws (e.g. build failure)', async () => {
    // Timeout no longer causes a failure (expected behavior when timeout > 0).
    godot.runBuild.mockRejectedValue(new Error('scons: *** Error 1'))

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('scons: *** Error 1')
  })

  it('calls setFailed when createHeaderArchive throws', async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === 'options') return 'create_header_archive'
      return (
        {
          version: '4.4',
          flavor: 'stable',
          directory: '/work',
          timeout: '0',
          platform: 'linuxbsd',
          target: 'editor',
          architecture: 'auto'
        }[name] ?? ''
      )
    })
    godot.createHeaderArchive.mockRejectedValue(new Error('disk full'))

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('disk full')
  })

  it('does not call setFailed when a non-Error is thrown', async () => {
    // Simulate a library throwing a raw string instead of an Error object
    godot.downloadAndExtract.mockImplementation(() => {
      throw 'something went wrong without an error object'
    })

    await run()

    // Line 121's 'if' will be false, so setFailed should not be called
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('uses default values for optional inputs when they are empty', async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === 'platform') return 'linuxbsd'
      if (name === 'target') return 'editor'
      if (name === 'version') return '4.4'
      // Return empty for everything else to trigger the || fallbacks
      return ''
    })

    await run()

    expect(godot.downloadAndExtract).toHaveBeenCalledWith(
      '4.4',
      'stable', // Default flavor
      expect.any(String)
    )
    expect(godot.runBuild).toHaveBeenCalledWith(
      expect.any(String),
      ['linuxbsd'],
      ['editor'],
      'auto',
      {},
      0,
      expect.any(Function)
    )
  })
})
