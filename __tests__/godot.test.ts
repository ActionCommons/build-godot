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
// realpathSync defaults to the identity so plain directory trees walk as
// before; cycle tests override it to map a link onto a visited directory.
const fsRealpathSync = jest.fn((p: unknown) => String(p))
jest.unstable_mockModule('node:fs', () => ({
  readdirSync: fsReaddirSync,
  statSync: fsStatSync,
  realpathSync: fsRealpathSync,
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
  VALID_ARCHITECTURES,
  SUPPORTED_MAJORS,
  EDITOR_UNSUPPORTED_PLATFORMS,
  GODOT3_ARCHITECTURES,
  GODOT3_MIN_TESTED_MINOR,
  GODOT3_PLATFORMS,
  GODOT3_TARGETS,
  GODOT3_SCONS_REQUIREMENT,
  GODOT4_ARCHITECTURES,
  MAX_TIMEOUT_SECONDS,
  OPTION_PLATFORMS,
  parseMajorVersion,
  parseTimeout,
  parseVersion,
  resolveArchArg,
  validateFlavor,
  validateInputsForMajor,
  HEADER_EXTENSIONS,
  SIGTERM_GRACE_MS
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
  type: 'file' | 'dir' | 'symlink'
): {
  name: string
  isDirectory: () => boolean
  isFile: () => boolean
  isSymbolicLink: () => boolean
} {
  // Like a real Dirent, a symlink reports neither directory nor file; the
  // code must stat it to learn what it points at.
  return {
    name,
    isDirectory: () => type === 'dir',
    isFile: () => type === 'file',
    isSymbolicLink: () => type === 'symlink'
  }
}

/** Returns a fake child that only exits when the test says so. */
function makeChildWithPid(pid?: number): EventEmitter & {
  kill: jest.Mock
  pid?: number
} {
  const child = new EventEmitter() as EventEmitter & {
    kill: jest.Mock
    pid?: number
  }
  child.kill = jest.fn()
  child.pid = pid
  return child
}

// ── Global setup / teardown ───────────────────────────────────────────────────

beforeEach(() => {
  osTmpdir.mockReturnValue('/tmp')
  fsRealpathSync.mockImplementation((p: unknown) => String(p))
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

  it('deduplicates repeated tokens so a combination is not built twice', () => {
    expect(parseMultiInput('linuxbsd, linuxbsd\nlinuxbsd')).toEqual([
      'linuxbsd'
    ])
  })

  it('keeps the first occurrence order when deduplicating', () => {
    expect(parseMultiInput('windows,linuxbsd,windows')).toEqual([
      'windows',
      'linuxbsd'
    ])
  })

  it('treats case variants as distinct tokens (validated later)', () => {
    expect(parseMultiInput('linuxbsd,LinuxBSD')).toEqual([
      'linuxbsd',
      'LinuxBSD'
    ])
  })

  it('handles trailing commas and blank lines from multi-line YAML', () => {
    expect(parseMultiInput('editor,\n\n template_release ,\n')).toEqual([
      'editor',
      'template_release'
    ])
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

  it('parses generate_bundle=yes', () => {
    expect(parseOptions('generate_bundle=yes')).toMatchObject({
      generate_bundle: 'yes'
    })
  })

  it('parses generate_bundle=no', () => {
    expect(parseOptions('generate_bundle=no')).toMatchObject({
      generate_bundle: 'no'
    })
  })

  it('throws on invalid generate_bundle value', () => {
    expect(() => parseOptions('generate_bundle=maybe')).toThrow(
      /Invalid generate_bundle value/
    )
  })

  it('parses ios_simulator=yes', () => {
    expect(parseOptions('ios_simulator=yes')).toMatchObject({
      ios_simulator: 'yes'
    })
  })

  it('parses ios_simulator=no', () => {
    expect(parseOptions('ios_simulator=no')).toMatchObject({
      ios_simulator: 'no'
    })
  })

  it('throws on invalid ios_simulator value', () => {
    expect(() => parseOptions('ios_simulator=maybe')).toThrow(
      /Invalid ios_simulator value/
    )
  })

  it('throws when the same option is given conflicting values', () => {
    expect(() => parseOptions('optimize=speed, optimize=size')).toThrow(
      'Conflicting values for option "optimize": "speed" and "size".'
    )
    expect(() => parseOptions('debug_symbols=yes\ndebug_symbols=no')).toThrow(
      'Conflicting values for option "debug_symbols"'
    )
    expect(() =>
      parseOptions('generate_bundle=yes,generate_bundle=no')
    ).toThrow('Conflicting values for option "generate_bundle"')
    expect(() => parseOptions('ios_simulator=no,ios_simulator=yes')).toThrow(
      'Conflicting values for option "ios_simulator"'
    )
  })

  it('accepts an identical option repeated', () => {
    expect(
      parseOptions(
        'optimize=size,optimize=size,create_header_archive,create_header_archive'
      )
    ).toEqual({ optimize: 'size', create_header_archive: true })
  })

  it('rejects an empty option value', () => {
    expect(() => parseOptions('debug_symbols=')).toThrow(
      'Invalid debug_symbols value: "".'
    )
    expect(() => parseOptions('optimize=')).toThrow(
      'Invalid optimize value: "".'
    )
  })

  it('lists every supported option when an unknown one is given', () => {
    expect(() => parseOptions('unknown_flag')).toThrow(
      'Unknown option: "unknown_flag". ' +
        'Supported: create_header_archive, debug_symbols=[yes|no], ' +
        'generate_bundle=[yes|no], ios_simulator=[yes|no], ' +
        'optimize=[speed_trace|speed|size|debug|none|custom].'
    )
  })

  it('lists the valid optimize levels when an invalid one is given', () => {
    expect(() => parseOptions('optimize=turbo')).toThrow(
      'Invalid optimize value: "turbo". Must be one of: speed_trace, speed, size, debug, none, custom.'
    )
  })

  it('returns an empty object for a whitespace-only string', () => {
    expect(parseOptions('  \n , ')).toEqual({})
  })

  it('rejects a value on the create_header_archive flag', () => {
    expect(() => parseOptions('create_header_archive=yes')).toThrow(
      'Unknown option: "create_header_archive=yes".'
    )
  })

  it('is case-sensitive for option names and values', () => {
    expect(() => parseOptions('OPTIMIZE=size')).toThrow('Unknown option')
    expect(() => parseOptions('optimize=Size')).toThrow(
      'Invalid optimize value: "Size".'
    )
    expect(() => parseOptions('debug_symbols=YES')).toThrow(
      'Invalid debug_symbols value: "YES".'
    )
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

  it('produces the expected URL for a 3.x patch release', () => {
    expect(buildDownloadUrl('3.5.3', 'stable')).toBe(
      'https://github.com/godotengine/godot-builds/releases/download/3.5.3-stable/godot-3.5.3-stable.tar.xz'
    )
  })

  it('produces the expected URL for a 3.x release candidate', () => {
    expect(buildDownloadUrl('3.6', 'rc1')).toBe(
      'https://github.com/godotengine/godot-builds/releases/download/3.6-rc1/godot-3.6-rc1.tar.xz'
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

  it('includes generate_bundle when set', () => {
    expect(
      buildSconsArgs('ios', 'template_release', 'arm64', {
        generate_bundle: 'yes'
      })
    ).toContain('generate_bundle=yes')
  })

  it('includes ios_simulator when set', () => {
    expect(
      buildSconsArgs('ios', 'template_debug', 'arm64', {
        ios_simulator: 'yes'
      })
    ).toContain('ios_simulator=yes')
  })

  it('combines all options including generate_bundle and ios_simulator', () => {
    expect(
      buildSconsArgs('ios', 'template_debug', 'arm64', {
        debug_symbols: 'yes',
        optimize: 'size',
        generate_bundle: 'yes',
        ios_simulator: 'no'
      })
    ).toEqual([
      'platform=ios',
      'target=template_debug',
      'arch=arm64',
      'debug_symbols=yes',
      'optimize=size',
      'generate_bundle=yes',
      'ios_simulator=no'
    ])
  })

  it('combines multiple options for web platform', () => {
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

// ── Expected translation tables (hand-written, independent of src) ───────────
//
// These deliberately duplicate the tables in src/godot.ts so that a typo in
// either place makes the exhaustive matrices below fail.

const EXPECTED_GODOT3_PLATFORM: Record<string, string> = {
  android: 'android',
  ios: 'iphone',
  linuxbsd: 'x11',
  macos: 'osx',
  web: 'javascript',
  windows: 'windows'
}

const EXPECTED_GODOT3_TARGET: Record<string, string[]> = {
  editor: ['tools=yes', 'target=release_debug'],
  template_debug: ['tools=no', 'target=release_debug'],
  template_release: ['tools=no', 'target=release']
}

const EXPECTED_ARCH_ARG: Record<
  3 | 4,
  Record<string, Record<string, string>>
> = {
  3: {
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
  },
  4: {
    android: {
      x86_32: 'arch=x86_32',
      x86_64: 'arch=x86_64',
      arm32: 'arch=arm32',
      arm64: 'arch=arm64'
    },
    ios: { x86_64: 'arch=x86_64', arm64: 'arch=arm64' },
    linuxbsd: {
      x86_32: 'arch=x86_32',
      x86_64: 'arch=x86_64',
      arm32: 'arch=arm32',
      arm64: 'arch=arm64',
      rv64: 'arch=rv64',
      ppc32: 'arch=ppc32',
      ppc64: 'arch=ppc64'
    },
    macos: { x86_64: 'arch=x86_64', arm64: 'arch=arm64' },
    web: { wasm32: 'arch=wasm32' },
    windows: {
      x86_32: 'arch=x86_32',
      x86_64: 'arch=x86_64',
      arm32: 'arch=arm32',
      arm64: 'arch=arm64'
    }
  }
}

const EXPECTED_NO_EDITOR: Record<3 | 4, string[]> = {
  3: ['android', 'ios'],
  4: ['ios']
}

const MAJORS = [3, 4] as const

/** Platform + target prefix of the SCons args for a given major. */
function expectedPrefix(major: 3 | 4, platform: string, target: string) {
  return major === 3
    ? [
        `platform=${EXPECTED_GODOT3_PLATFORM[platform]}`,
        ...EXPECTED_GODOT3_TARGET[target]
      ]
    : [`platform=${platform}`, `target=${target}`]
}

/** Captures the message thrown by `fn`, or undefined when it does not throw. */
function thrownMessage(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (err) {
    return (err as Error).message
  }
  return undefined
}

// ── parseVersion / parseMajorVersion ──────────────────────────────────────────

describe('parseVersion', () => {
  it.each([
    ['4.4', { major: 4, minor: 4 }],
    ['4.0', { major: 4, minor: 0 }],
    ['4.6.1', { major: 4, minor: 6, patch: 1 }],
    ['4.10', { major: 4, minor: 10 }],
    ['4.10.2', { major: 4, minor: 10, patch: 2 }],
    ['4.6.12', { major: 4, minor: 6, patch: 12 }],
    ['3.6', { major: 3, minor: 6 }],
    ['3.5.3', { major: 3, minor: 5, patch: 3 }],
    ['3.0', { major: 3, minor: 0 }]
  ])('parses %s', (input, expected) => {
    expect(parseVersion(input)).toEqual(expected)
  })

  it.each([
    'latest',
    '4',
    '',
    ' 3.6',
    '3.6 ',
    '4.4-stable',
    'v4.4',
    '4.4.1.2',
    '04.4',
    '4.04',
    '4.4.01',
    '4..4',
    '4.4.'
  ])('rejects the malformed version %j', (input) => {
    expect(() => parseVersion(input)).toThrow(`Invalid version: "${input}"`)
  })

  it('explains the expected format for malformed versions', () => {
    expect(() => parseVersion('latest')).toThrow(
      'Invalid version: "latest". ' +
        'Expected MAJOR.MINOR or MAJOR.MINOR.PATCH such as "4.4" or "3.5.3".'
    )
  })

  it('rejects a ".0" patch and suggests the tag name', () => {
    expect(() => parseVersion('4.4.0')).toThrow(
      'Invalid version: "4.4.0". Godot release tags omit'
    )
    expect(() => parseVersion('4.4.0')).toThrow(
      'Godot release tags omit a ".0" patch; use "4.4".'
    )
  })

  it.each([
    ['2.1.6', 2],
    ['5.0', 5],
    ['0.1', 0],
    ['1.1', 1]
  ])('rejects the unsupported major in %s', (input, major) => {
    expect(() => parseVersion(input)).toThrow(
      `Unsupported Godot major version: ${major} (from "${input}"). ` +
        `Supported major versions: 3, 4.`
    )
  })

  it('parseMajorVersion returns only the major component', () => {
    expect(parseMajorVersion('3.5.3')).toBe(3)
    expect(parseMajorVersion('4.6.1')).toBe(4)
    expect(() => parseMajorVersion('9.0')).toThrow('Unsupported')
  })

  it('exposes the supported majors and the oldest tested 3.x minor', () => {
    expect(SUPPORTED_MAJORS).toEqual([3, 4])
    expect(GODOT3_MIN_TESTED_MINOR).toBe(5)
  })
})

// ── validateFlavor ────────────────────────────────────────────────────────────

describe('validateFlavor', () => {
  it.each(['stable', 'dev1', 'dev6', 'alpha1', 'beta2', 'rc1', 'rc10'])(
    'accepts %s',
    (flavor) => {
      expect(() => validateFlavor(flavor)).not.toThrow()
    }
  )

  it.each([
    '',
    'Stable',
    'STABLE',
    'stable2',
    'rc',
    'rc0',
    'rc01',
    'beta-1',
    'rc 1',
    'rc1 ',
    'rc1/../evil',
    'rc1;rm',
    'stable_mono',
    'gamma1',
    'xstable',
    'prerc1',
    'my-rc1'
  ])('rejects %j', (flavor) => {
    expect(() => validateFlavor(flavor)).toThrow(
      `Invalid flavor: "${flavor}". ` +
        `Must be "stable" or one of devN, alphaN, betaN, rcN (e.g. "rc1").`
    )
  })
})

// ── parseTimeout ──────────────────────────────────────────────────────────────

describe('parseTimeout', () => {
  it.each([
    ['0', 0],
    ['40', 40],
    ['007', 7],
    ['2147483', 2147483]
  ])('parses %j as %d seconds', (input, expected) => {
    expect(parseTimeout(input)).toBe(expected)
  })

  it.each(['1.5', '10abc', '-1', '+5', ' 5', '5 ', '', 'abc', '1e3', '0x10'])(
    'rejects %j instead of truncating it',
    (input) => {
      expect(() => parseTimeout(input)).toThrow(
        `Invalid timeout value: "${input}". ` +
          `Must be a non-negative integer number of seconds (0 = no timeout).`
      )
    }
  )

  it('rejects timeouts that would overflow the Node.js timer', () => {
    expect(MAX_TIMEOUT_SECONDS).toBe(2147483)
    expect(() => parseTimeout('2147484')).toThrow(
      new Error(
        'Invalid timeout value: "2147484". ' +
          'Must not exceed 2147483 seconds (about 24.8 days).'
      )
    )
    expect(() => parseTimeout('99999999999999999999')).toThrow(
      'Must not exceed 2147483 seconds'
    )
  })
})

// ── Architecture translation (exhaustive) ─────────────────────────────────────

const ARCH_CASES = MAJORS.flatMap((major) =>
  VALID_PLATFORMS.flatMap((platform) =>
    VALID_ARCHITECTURES.filter((a) => a !== 'auto').map(
      (arch) =>
        [major, platform, arch, EXPECTED_ARCH_ARG[major][platform][arch]] as [
          3 | 4,
          string,
          string,
          string | undefined
        ]
    )
  )
)

describe('architecture translation matrix', () => {
  it('covers every major × platform × architecture', () => {
    expect(ARCH_CASES).toHaveLength(2 * 6 * 8)
  })

  const SUPPORTED_ARCH_CASES = ARCH_CASES.filter((c) => c[3] !== undefined)
  const REJECTED_ARCH_CASES = ARCH_CASES.filter((c) => c[3] === undefined)

  it('splits into supported and rejected combinations', () => {
    expect(SUPPORTED_ARCH_CASES.length + REJECTED_ARCH_CASES.length).toBe(96)
    expect(SUPPORTED_ARCH_CASES).toHaveLength(11 + 20) // 3.x: 11 mapped, 4.x: 20 supported
  })

  it.each(SUPPORTED_ARCH_CASES)(
    'Godot %s.x %s + %s → %s',
    (major, platform, arch, expected) => {
      expect(resolveArchArg(platform, arch, major)).toBe(expected)
      expect(
        buildSconsArgs(platform, 'template_release', arch, {}, major)
      ).toStrictEqual([
        ...expectedPrefix(major, platform, 'template_release'),
        expected
      ])
      expect(() =>
        validateInputsForMajor(
          major,
          [platform],
          ['template_release'],
          arch,
          {}
        )
      ).not.toThrow()
    }
  )

  it.each(REJECTED_ARCH_CASES)(
    'Godot %s.x %s + %s is rejected',
    (major, platform, arch) => {
      const message =
        `Architecture "${arch}" is not supported for platform ` +
        `"${platform}" when building Godot ${major}.x.`
      const build = () =>
        buildSconsArgs(platform, 'template_release', arch, {}, major)
      const validate = () =>
        validateInputsForMajor(
          major,
          [platform],
          ['template_release'],
          arch,
          {}
        )
      expect(build).toThrow(message)
      expect(validate).toThrow(message)
      // Single source of truth: both entry points report the same error.
      expect(thrownMessage(build)).toBe(thrownMessage(validate))
    }
  )

  it.each(MAJORS.flatMap((m) => VALID_PLATFORMS.map((p) => [m, p] as const)))(
    'Godot %s.x %s + auto omits the architecture argument',
    (major, platform) => {
      expect(resolveArchArg(platform, 'auto', major)).toBeUndefined()
      expect(
        buildSconsArgs(platform, 'template_release', 'auto', {}, major)
      ).toStrictEqual(expectedPrefix(major, platform, 'template_release'))
      expect(() =>
        validateInputsForMajor(
          major,
          [platform],
          ['template_release'],
          'auto',
          {}
        )
      ).not.toThrow()
    }
  )

  it('lists the supported architectures in the rejection message', () => {
    expect(() => resolveArchArg('linuxbsd', 'rv64', 3)).toThrow(
      'Supported: auto, x86_32, x86_64.'
    )
    expect(() => resolveArchArg('web', 'x86_64', 4)).toThrow(
      'Supported: auto, wasm32.'
    )
    expect(() => resolveArchArg('web', 'wasm32', 3)).toThrow(
      'Only "auto" is supported.'
    )
  })

  it('source tables have an entry for every platform', () => {
    for (const platform of VALID_PLATFORMS) {
      expect(GODOT3_PLATFORMS[platform]).toBe(
        EXPECTED_GODOT3_PLATFORM[platform]
      )
      expect(GODOT3_ARCHITECTURES[platform]).toBeDefined()
      expect(GODOT4_ARCHITECTURES[platform]).toBeDefined()
    }
  })
})

// ── Platform × target translation (exhaustive) ────────────────────────────────

const TARGET_CASES = MAJORS.flatMap((major) =>
  VALID_PLATFORMS.flatMap((platform) =>
    VALID_TARGETS.map(
      (target) =>
        [
          major,
          platform,
          target,
          target === 'editor' && EXPECTED_NO_EDITOR[major].includes(platform)
        ] as [3 | 4, string, string, boolean]
    )
  )
)

describe('platform × target translation matrix', () => {
  it('covers every major × platform × target', () => {
    expect(TARGET_CASES).toHaveLength(2 * 6 * 3)
  })

  it.each(TARGET_CASES)(
    'Godot %s.x %s + %s translates to the expected SCons args',
    (major, platform, target) => {
      expect(buildSconsArgs(platform, target, 'auto', {}, major)).toStrictEqual(
        expectedPrefix(major, platform, target)
      )
    }
  )

  it.each(TARGET_CASES.filter((c) => !c[3]))(
    'Godot %s.x %s + %s passes validation',
    (major, platform, target) => {
      expect(() =>
        validateInputsForMajor(major, [platform], [target], 'auto', {})
      ).not.toThrow()
    }
  )

  it.each(TARGET_CASES.filter((c) => c[3]))(
    'Godot %s.x %s + %s is rejected (no editor build)',
    (major, platform, target) => {
      expect(() =>
        validateInputsForMajor(major, [platform], [target], 'auto', {})
      ).toThrow(
        `Target "editor" is not available for platform "${platform}" ` +
          `when building Godot ${major}.x. ` +
          `Use template_debug or template_release instead.`
      )
    }
  )

  it('rejects exactly the expected number of editor combinations', () => {
    expect(TARGET_CASES.filter((c) => c[3])).toHaveLength(3)
  })

  it('source tables match the expected translations', () => {
    expect(GODOT3_TARGETS).toEqual(EXPECTED_GODOT3_TARGET)
    expect(EDITOR_UNSUPPORTED_PLATFORMS).toEqual(EXPECTED_NO_EDITOR)
  })

  it('names the first platform without an editor in a multi-platform build', () => {
    expect(() =>
      validateInputsForMajor(
        3,
        ['linuxbsd', 'ios', 'android'],
        ['template_release', 'editor'],
        'auto',
        {}
      )
    ).toThrow('platform "ios"')
  })

  it('allows template-only builds for platforms without an editor', () => {
    expect(() =>
      validateInputsForMajor(
        3,
        ['android', 'ios'],
        ['template_debug', 'template_release'],
        'auto',
        {}
      )
    ).not.toThrow()
  })
})

// ── Platform-aware option validation (exhaustive) ─────────────────────────────

const OPTION_ALLOWED: Record<'generate_bundle' | 'ios_simulator', string[]> = {
  generate_bundle: ['macos', 'ios'],
  ios_simulator: ['ios']
}

const OPTION_CASES = MAJORS.flatMap((major) =>
  (['generate_bundle', 'ios_simulator'] as const).flatMap((option) =>
    VALID_PLATFORMS.map(
      (platform) =>
        [major, option, platform] as [
          3 | 4,
          'generate_bundle' | 'ios_simulator',
          string
        ]
    )
  )
)

describe('platform-aware option validation matrix', () => {
  const validateOption =
    (
      major: 3 | 4,
      option: 'generate_bundle' | 'ios_simulator',
      platform: string
    ) =>
    () =>
      validateInputsForMajor(major, [platform], ['template_release'], 'auto', {
        [option]: 'yes'
      })

  // 3.x rejects generate_bundle outright, with a 3.x-specific message.
  const GODOT3_BUNDLE_CASES = OPTION_CASES.filter(
    ([m, o]) => m === 3 && o === 'generate_bundle'
  )
  const PLATFORM_CASES = OPTION_CASES.filter(
    ([m, o]) => !(m === 3 && o === 'generate_bundle')
  )

  it.each(GODOT3_BUNDLE_CASES)(
    'Godot %s.x %s on %s is rejected as 4.x-only',
    (major, option, platform) => {
      expect(validateOption(major, option, platform)).toThrow(
        'generate_bundle is only supported when building Godot 4.x. ' +
          'Godot 3.x creates app bundles via the scripts in misc/dist instead.'
      )
    }
  )

  it.each(PLATFORM_CASES.filter(([, o, p]) => OPTION_ALLOWED[o].includes(p)))(
    'Godot %s.x %s on %s is accepted',
    (major, option, platform) => {
      expect(validateOption(major, option, platform)).not.toThrow()
    }
  )

  it.each(PLATFORM_CASES.filter(([, o, p]) => !OPTION_ALLOWED[o].includes(p)))(
    'Godot %s.x %s on %s is rejected for the platform',
    (major, option, platform) => {
      expect(validateOption(major, option, platform)).toThrow(
        `Option "${option}" is only supported for platform(s) ` +
          `${OPTION_ALLOWED[option].join(', ')}, but "${platform}" was requested.`
      )
    }
  )

  it('source table matches the expected platforms', () => {
    expect(OPTION_PLATFORMS).toEqual(OPTION_ALLOWED)
  })

  it('rejects a platform-specific option when any requested platform is incompatible', () => {
    expect(() =>
      validateInputsForMajor(4, ['ios', 'macos'], ['template_debug'], 'auto', {
        ios_simulator: 'no'
      })
    ).toThrow('but "macos" was requested')
  })

  it('accepts generate_bundle for macos + ios together on 4.x', () => {
    expect(() =>
      validateInputsForMajor(4, ['macos', 'ios'], ['template_debug'], 'auto', {
        generate_bundle: 'no'
      })
    ).not.toThrow()
  })

  it('does not restrict platform-agnostic options', () => {
    for (const major of MAJORS) {
      expect(() =>
        validateInputsForMajor(
          major,
          [...VALID_PLATFORMS],
          ['template_release'],
          'auto',
          { debug_symbols: 'yes', create_header_archive: true }
        )
      ).not.toThrow()
    }
  })
})

// ── Godot 3.x optimize levels ─────────────────────────────────────────────────

describe('Godot 3.x optimize validation', () => {
  it.each(['speed', 'size', 'none'] as const)('accepts optimize=%s', (val) => {
    expect(() =>
      validateInputsForMajor(3, ['linuxbsd'], ['editor'], 'auto', {
        optimize: val
      })
    ).not.toThrow()
    expect(
      buildSconsArgs('linuxbsd', 'editor', 'auto', { optimize: val }, 3)
    ).toContain(`optimize=${val}`)
  })

  it.each(['speed_trace', 'debug', 'custom'] as const)(
    'rejects optimize=%s on 3.x but accepts it on 4.x',
    (val) => {
      expect(() =>
        validateInputsForMajor(3, ['linuxbsd'], ['editor'], 'auto', {
          optimize: val
        })
      ).toThrow(
        `optimize=${val} is not supported when building Godot 3.x. ` +
          `Supported: speed, size, none.`
      )
      expect(() =>
        validateInputsForMajor(4, ['linuxbsd'], ['editor'], 'auto', {
          optimize: val
        })
      ).not.toThrow()
    }
  )

  it('reports generate_bundle before optimize on 3.x', () => {
    expect(() =>
      validateInputsForMajor(3, ['macos'], ['editor'], 'auto', {
        generate_bundle: 'yes',
        optimize: 'custom'
      })
    ).toThrow('generate_bundle is only supported')
  })

  it('passes debug_symbols and ios_simulator through for 3.x iOS', () => {
    expect(
      buildSconsArgs(
        'ios',
        'template_debug',
        'arm64',
        { debug_symbols: 'yes', optimize: 'size', ios_simulator: 'yes' },
        3
      )
    ).toEqual([
      'platform=iphone',
      'tools=no',
      'target=release_debug',
      'arch=arm64',
      'debug_symbols=yes',
      'optimize=size',
      'ios_simulator=yes'
    ])
  })

  it('defaults to Godot 4.x behaviour when no major is given', () => {
    expect(buildSconsArgs('linuxbsd', 'editor', 'x86_64', {})).toEqual([
      'platform=linuxbsd',
      'target=editor',
      'arch=x86_64'
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
    fsReaddirSync.mockReturnValue(['something-else', 'notes.txt'])
    fsStatSync.mockReturnValue({ isDirectory: () => true })

    await expect(downloadAndExtract('4.4', 'stable', '/work')).rejects.toThrow(
      'Extraction succeeded but no "godot-*" directory was found in /work. ' +
        'Entries: something-else, notes.txt'
    )
  })

  it.each([
    ['3.5.3', 'stable'],
    ['3.6', 'rc1']
  ])(
    'downloads and resolves the 3.x source tree for %s-%s',
    async (version, flavor) => {
      const name = `godot-${version}-${flavor}`
      fsReaddirSync.mockReturnValue([name])

      const result = await downloadAndExtract(version, flavor, '/work')

      expect(tcDownloadTool).toHaveBeenCalledWith(
        `https://github.com/godotengine/godot-builds/releases/download/${version}-${flavor}/${name}.tar.xz`
      )
      expect(tcExtractTar).toHaveBeenCalledWith(
        '/tmp/godot.tar.xz',
        '/work',
        'xJ'
      )
      expect(result).toBe(`/work/${name}`)
    }
  )

  it('prefers the directory matching version and flavor in a reused directory', async () => {
    // A cached 4.x tree sorts before the freshly extracted 3.x tree.
    fsReaddirSync.mockReturnValue(['godot-4.4-stable', 'godot-3.6-stable'])

    const result = await downloadAndExtract('3.6', 'stable', '/work')

    expect(result).toBe('/work/godot-3.6-stable')
  })

  it('falls back to the only godot-* directory when the name differs', async () => {
    fsReaddirSync.mockReturnValue(['godot-4.4-stable-src', 'README.txt'])
    fsStatSync.mockImplementation((p: unknown) => ({
      isDirectory: () => !String(p).endsWith('.txt')
    }))

    const result = await downloadAndExtract('4.4', 'stable', '/work')

    expect(result).toBe('/work/godot-4.4-stable-src')
  })

  it('throws instead of guessing when several non-matching godot-* directories exist', async () => {
    fsReaddirSync.mockReturnValue(['godot-4.3-stable', 'godot-4.5-stable'])

    await expect(downloadAndExtract('4.4', 'stable', '/work')).rejects.toThrow(
      'Expected "godot-4.4-stable" in /work but found several other godot-* ' +
        'directories: godot-4.3-stable, godot-4.5-stable. Use an empty working directory.'
    )
  })

  it('ignores godot-* entries that are files, not directories', async () => {
    fsReaddirSync.mockReturnValue([
      'godot-4.4-stable.tar.xz',
      'godot-4.4-stable'
    ])
    fsStatSync.mockImplementation((p: unknown) => ({
      isDirectory: () => !String(p).endsWith('.tar.xz')
    }))

    const result = await downloadAndExtract('4.4', 'stable', '/work')

    expect(result).toBe('/work/godot-4.4-stable')
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

  it('pins SCons below 4.8 for Godot 3.x', () => {
    expect(GODOT3_SCONS_REQUIREMENT).toBe('scons<4.8')
  })

  it('installs the pinned scons range for Godot 3.x', async () => {
    execExec.mockResolvedValue(0)
    await setupScons(3)
    expect(execExec).toHaveBeenCalledWith('pip3', [
      'install',
      '--quiet',
      '--break-system-packages',
      GODOT3_SCONS_REQUIREMENT
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

  it('translates the scons args when building Godot 3.x', async () => {
    spawnMock.mockImplementation(() => makeFakeChild(0))

    await runBuild(
      '/src',
      ['linuxbsd'],
      ['template_release'],
      'x86_64',
      {},
      0,
      undefined,
      3
    )

    expect(spawnMock).toHaveBeenCalledWith(
      'scons',
      ['platform=x11', 'tools=no', 'target=release', 'bits=64'],
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
    jest.useFakeTimers()
    const child = new EventEmitter() as EventEmitter & { kill: jest.Mock }
    child.kill = jest.fn()
    spawnMock.mockReturnValue(child)
    const onTimeout = jest.fn<() => Promise<void>>().mockResolvedValue()

    const build = runBuild(
      '/src',
      ['linuxbsd'],
      ['editor'],
      'auto',
      {},
      10,
      onTimeout
    )
    child.emit('exit', 0, null)
    await expect(build).resolves.toBeUndefined()

    // Had the timer survived, it would fire here and kill the process.
    await jest.advanceTimersByTimeAsync(20_000)
    expect(onTimeout).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
    jest.useRealTimers()
  })

  it('clears the timeout when the child process emits an error', async () => {
    jest.useFakeTimers()
    const child = new EventEmitter() as EventEmitter & { kill: jest.Mock }
    child.kill = jest.fn()
    spawnMock.mockReturnValue(child)
    const onTimeout = jest.fn<() => Promise<void>>().mockResolvedValue()

    const build = runBuild(
      '/src',
      ['linuxbsd'],
      ['editor'],
      'auto',
      {},
      10,
      onTimeout
    )
    child.emit('error', new Error('spawn ENOENT'))
    await expect(build).rejects.toThrow('spawn ENOENT')

    await jest.advanceTimersByTimeAsync(20_000)
    expect(onTimeout).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
    jest.useRealTimers()
  })

  it('never arms a timer when the timeout is 0', async () => {
    jest.useFakeTimers()
    const child = new EventEmitter() as EventEmitter & { kill: jest.Mock }
    child.kill = jest.fn()
    spawnMock.mockReturnValue(child)

    const build = runBuild('/src', ['linuxbsd'], ['editor'], 'auto', {}, 0)
    expect(jest.getTimerCount()).toBe(0)
    await jest.advanceTimersByTimeAsync(1000)
    expect(child.kill).not.toHaveBeenCalled()

    child.emit('exit', 0, null)
    await expect(build).resolves.toBeUndefined()
    jest.useRealTimers()
  })

  it('names only platform and target in the exit-code error, not the full args', async () => {
    spawnMock.mockImplementation(() => makeFakeChild(1))

    await expect(
      runBuild(
        '/src',
        ['linuxbsd'],
        ['editor'],
        'x86_64',
        { optimize: 'size' },
        0
      )
    ).rejects.toThrow(
      new Error('Build exited with code 1 (platform=linuxbsd target=editor)')
    )
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

// ── runBuild: whole-run timeout (deadline shared across combinations) ────────

/** A fake child process whose exit is controlled by the test. */
function makeManualChild(): EventEmitter & { kill: jest.Mock } {
  const child = new EventEmitter() as EventEmitter & { kill: jest.Mock }
  child.kill = jest.fn()
  return child
}

describe('runBuild whole-run timeout', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('gives later combinations only the time left until the shared deadline', async () => {
    jest.useFakeTimers()
    const first = makeManualChild()
    const second = makeManualChild()
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const onTimeout = jest.fn<() => Promise<void>>().mockResolvedValue()

    const build = runBuild(
      '/src',
      ['linuxbsd'],
      ['template_debug', 'template_release'],
      'auto',
      {},
      2, // 2 seconds for the whole run
      onTimeout
    )

    // First combination finishes after 1.5 s.
    await jest.advanceTimersByTimeAsync(1500)
    first.emit('exit', 0, null)
    await jest.advanceTimersByTimeAsync(0)
    expect(spawnMock).toHaveBeenCalledTimes(2)

    // Second combination has 0.5 s left, not a fresh 2 s.
    await jest.advanceTimersByTimeAsync(499)
    expect(second.kill).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(second.kill).toHaveBeenCalledWith('SIGTERM')

    second.emit('exit', null, 'SIGTERM')
    await expect(build).resolves.toBeUndefined()
    expect(coreWarning).toHaveBeenCalledWith(
      'Build loop terminated due to timeout.'
    )
  })

  it('stops before spawning when the deadline passed between combinations', async () => {
    // Date.now: deadline computed at 0, first check at 0, second check at 5 s.
    const now = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(5000)
    spawnMock.mockImplementation(() => makeFakeChild(0))
    const onTimeout = jest.fn<() => Promise<void>>().mockResolvedValue()

    await runBuild(
      '/src',
      ['linuxbsd', 'windows'],
      ['editor'],
      'auto',
      {},
      1,
      onTimeout
    )

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(coreInfo).toHaveBeenCalledWith(
      'Timeout reached between builds. Securing headers...'
    )
    expect(coreWarning).toHaveBeenCalledWith(
      'Build loop terminated due to timeout.'
    )
    now.mockRestore()
  })

  it('stops when exactly no time is left (0 ms would mean "no timeout")', async () => {
    // Deadline at 1000 ms; second check happens exactly at the deadline.
    const now = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(1000)
    spawnMock.mockImplementation(() => makeFakeChild(0))

    await runBuild(
      '/src',
      ['linuxbsd'],
      ['editor', 'template_release'],
      'auto',
      {},
      1
    )

    expect(spawnMock).toHaveBeenCalledTimes(1)
    now.mockRestore()
  })

  it('logs (does not throw) when onTimeout fails between combinations', async () => {
    const now = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(5000)
    spawnMock.mockImplementation(() => makeFakeChild(0))

    await expect(
      runBuild(
        '/src',
        ['linuxbsd'],
        ['editor', 'template_release'],
        'auto',
        {},
        1,
        () => Promise.reject(new Error('disk full'))
      )
    ).resolves.toBeUndefined()

    expect(coreError).toHaveBeenCalledWith(
      'Header archiving failed during timeout: Error: disk full'
    )
    now.mockRestore()
  })

  it('stops between combinations without a callback when none is given', async () => {
    const now = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(5000)
    spawnMock.mockImplementation(() => makeFakeChild(0))

    await runBuild(
      '/src',
      ['linuxbsd'],
      ['editor', 'template_release'],
      'auto',
      {},
      1
    )

    expect(spawnMock).toHaveBeenCalledTimes(1)
    // A missing callback is skipped, not invoked and logged as a failure.
    expect(coreError).not.toHaveBeenCalled()
    now.mockRestore()
  })

  it('never computes a deadline when the timeout is 0', async () => {
    const now = jest.spyOn(Date, 'now')
    spawnMock.mockImplementation(() => makeFakeChild(0))

    await runBuild('/src', ['linuxbsd', 'windows'], ['editor'], 'auto', {}, 0)

    expect(now).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledTimes(2)
    now.mockRestore()
  })
})

// ── spawnWithTimeout edge cases ───────────────────────────────────────────────

describe('spawnWithTimeout edge cases', () => {
  it('rejects when the process exits with neither a code nor a signal', async () => {
    spawnMock.mockImplementation(() => makeFakeChild(null, null))

    await expect(
      runBuild('/src', ['linuxbsd'], ['editor'], 'auto', {}, 0)
    ).rejects.toThrow(
      'Build exited with code null (platform=linuxbsd target=editor)'
    )
  })

  it('keeps the first outcome when an error event follows exit', async () => {
    const child = makeManualChild()
    spawnMock.mockReturnValue(child)

    const build = runBuild('/src', ['linuxbsd'], ['editor'], 'auto', {}, 0)
    child.emit('exit', 0, null)
    child.emit('error', new Error('late error'))

    await expect(build).resolves.toBeUndefined()
  })

  it('spawns scons with inherited stdio in the source directory', async () => {
    spawnMock.mockImplementation(() => makeFakeChild(0))

    await runBuild(
      '/src/godot-3.6-stable',
      ['macos'],
      ['editor'],
      'arm64',
      {},
      0,
      undefined,
      3
    )

    expect(spawnMock).toHaveBeenCalledWith(
      'scons',
      ['platform=osx', 'tools=yes', 'target=release_debug', 'arch=arm64'],
      { cwd: '/src/godot-3.6-stable', stdio: 'inherit', detached: true }
    )
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
    // Empty directory — no *.glsl, *.h, *.hh, *.hpp, *.inc, and *.inl files at any level.
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

  it('includes every header extension by suffix only', async () => {
    fsReaddirSync.mockImplementation((dir: unknown) => {
      if (dir === '/src') {
        return [
          makeDirent('a.glsl', 'file'),
          makeDirent('b.h', 'file'),
          makeDirent('c.hh', 'file'),
          makeDirent('d.hpp', 'file'),
          makeDirent('e.inc', 'file'),
          makeDirent('f.inl', 'file'),
          // Extension only as a prefix / middle part: must be ignored.
          makeDirent('.glsl.bak', 'file'),
          makeDirent('.hh.orig', 'file'),
          makeDirent('.inc.txt', 'file'),
          makeDirent('.inl.old', 'file'),
          makeDirent('.h.swp', 'file')
        ]
      }
      return []
    })

    await createHeaderArchive('/src')

    expect(fsReaddirSync).toHaveBeenCalledWith('/src', { withFileTypes: true })
    expect(admZipInstance.addLocalFile.mock.calls.map((c) => c[0])).toEqual([
      '/src/a.glsl',
      '/src/b.h',
      '/src/c.hh',
      '/src/d.hpp',
      '/src/e.inc',
      '/src/f.inl'
    ])
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

// ── Regression: build failure while the timeout callback runs (BUG1) ─────────

describe('spawnWithTimeout – exit during the timeout callback', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  /** onTimeout that only resolves when the test calls `finish()`. */
  function makeSlowCallback(): {
    onTimeout: jest.Mock<() => Promise<void>>
    finish: () => void
  } {
    let finish: () => void = () => {}
    const onTimeout = jest.fn<() => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    return { onTimeout, finish: () => finish() }
  }

  it('reports a non-zero exit that arrives while headers are being archived', async () => {
    jest.useFakeTimers()
    const child = makeChildWithPid()
    spawnMock.mockReturnValue(child)
    const { onTimeout, finish } = makeSlowCallback()

    const build = runBuild(
      '/src',
      ['linuxbsd'],
      ['editor'],
      'auto',
      {},
      1,
      onTimeout
    )
    await jest.advanceTimersByTimeAsync(1500)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    // The archive is still running: nothing has been killed yet.
    expect(child.kill).not.toHaveBeenCalled()

    // SCons fails on its own in the meantime.
    child.emit('exit', 2, null)
    finish()

    await expect(build).rejects.toThrow(
      'Build exited with code 2 (platform=linuxbsd target=editor)'
    )
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('treats a clean exit during the archive as a completed build, not a timeout', async () => {
    jest.useFakeTimers()
    const child = makeChildWithPid()
    spawnMock.mockReturnValue(child)
    const { onTimeout, finish } = makeSlowCallback()

    const build = runBuild(
      '/src',
      ['linuxbsd'],
      ['editor'],
      'auto',
      {},
      1,
      onTimeout
    )
    await jest.advanceTimersByTimeAsync(1500)

    child.emit('exit', 0, null)
    finish()

    await expect(build).resolves.toBeUndefined()
    expect(child.kill).not.toHaveBeenCalled()
    expect(coreWarning).not.toHaveBeenCalledWith(
      'Build loop terminated due to timeout.'
    )
  })

  it('waits for the archive to finish before settling', async () => {
    jest.useFakeTimers()
    const child = makeChildWithPid()
    spawnMock.mockReturnValue(child)
    const { onTimeout, finish } = makeSlowCallback()
    let settled = false

    const build = runBuild(
      '/src',
      ['linuxbsd'],
      ['editor'],
      'auto',
      {},
      1,
      onTimeout
    ).finally(() => {
      settled = true
    })
    await jest.advanceTimersByTimeAsync(1500)
    child.emit('exit', 2, null)
    await jest.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false) // archive still in flight

    finish()
    await expect(build).rejects.toThrow('Build exited with code 2')
    expect(settled).toBe(true)
  })

  it('still kills and treats the exit as a timeout once the archive has finished', async () => {
    jest.useFakeTimers()
    const child = makeChildWithPid()
    spawnMock.mockReturnValue(child)
    const { onTimeout, finish } = makeSlowCallback()

    const build = runBuild(
      '/src',
      ['linuxbsd'],
      ['editor'],
      'auto',
      {},
      1,
      onTimeout
    )
    await jest.advanceTimersByTimeAsync(1500)
    finish()
    await jest.advanceTimersByTimeAsync(0)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')

    child.emit('exit', 2, null) // SCons' own cleanup exit after SIGTERM
    await expect(build).resolves.toBeUndefined()
    expect(coreWarning).toHaveBeenCalledWith(
      'Build loop terminated due to timeout.'
    )
  })
})

// ── Regression: SIGKILL escalation and process-group signalling (BUG2) ───────

describe('spawnWithTimeout – termination', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  let processKill: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    processKill = jest.spyOn(process, 'kill').mockImplementation(() => true)
  })

  afterEach(() => {
    processKill.mockRestore()
    Object.defineProperty(process, 'platform', realPlatform)
    jest.useRealTimers()
  })

  it('exports a grace period of 10 seconds', () => {
    expect(SIGTERM_GRACE_MS).toBe(10_000)
  })

  it('sends SIGKILL when the build ignores SIGTERM for the grace period', async () => {
    jest.useFakeTimers()
    const child = makeChildWithPid()
    spawnMock.mockReturnValue(child)

    const build = runBuild('/src', ['linuxbsd'], ['editor'], 'auto', {}, 1)
    await jest.advanceTimersByTimeAsync(1000)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')

    await jest.advanceTimersByTimeAsync(SIGTERM_GRACE_MS - 1)
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
    await jest.advanceTimersByTimeAsync(1)
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL')
    expect(coreWarning).toHaveBeenCalledWith(
      `Build did not exit ${SIGTERM_GRACE_MS} ms after SIGTERM; sending SIGKILL.`
    )

    // A SIGKILL exit after a configured timeout is still a timeout, not a failure.
    child.emit('exit', null, 'SIGKILL')
    await expect(build).resolves.toBeUndefined()
  })

  it('does not send SIGKILL when the build exits within the grace period', async () => {
    jest.useFakeTimers()
    const child = makeChildWithPid()
    spawnMock.mockReturnValue(child)

    const build = runBuild('/src', ['linuxbsd'], ['editor'], 'auto', {}, 1)
    await jest.advanceTimersByTimeAsync(1000)
    child.emit('exit', null, 'SIGTERM')
    await expect(build).resolves.toBeUndefined()

    await jest.advanceTimersByTimeAsync(SIGTERM_GRACE_MS * 2)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
    expect(jest.getTimerCount()).toBe(0)
  })

  it('clears the SIGKILL timer when the child errors after SIGTERM', async () => {
    jest.useFakeTimers()
    const child = makeChildWithPid()
    spawnMock.mockReturnValue(child)

    const build = runBuild('/src', ['linuxbsd'], ['editor'], 'auto', {}, 1)
    await jest.advanceTimersByTimeAsync(1000)
    child.emit('error', new Error('kill failed'))
    await expect(build).rejects.toThrow('kill failed')
    expect(jest.getTimerCount()).toBe(0)
  })

  it('signals the whole process group on POSIX so compiler children stop too', async () => {
    jest.useFakeTimers()
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const child = makeChildWithPid(4242)
    spawnMock.mockReturnValue(child)

    const build = runBuild('/src', ['linuxbsd'], ['editor'], 'auto', {}, 1)
    await jest.advanceTimersByTimeAsync(1000)

    expect(spawnMock).toHaveBeenCalledWith('scons', expect.any(Array), {
      cwd: '/src',
      stdio: 'inherit',
      detached: true
    })
    expect(processKill).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(child.kill).not.toHaveBeenCalled()

    child.emit('exit', null, 'SIGTERM')
    await expect(build).resolves.toBeUndefined()
  })

  it('falls back to child.kill when the process group is already gone', async () => {
    jest.useFakeTimers()
    Object.defineProperty(process, 'platform', { value: 'linux' })
    processKill.mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    })
    const child = makeChildWithPid(4242)
    spawnMock.mockReturnValue(child)

    const build = runBuild('/src', ['linuxbsd'], ['editor'], 'auto', {}, 1)
    await jest.advanceTimersByTimeAsync(1000)

    expect(processKill).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')

    child.emit('exit', null, 'SIGTERM')
    await expect(build).resolves.toBeUndefined()
  })

  it('uses a plain kill and no process group on Windows', async () => {
    jest.useFakeTimers()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const child = makeChildWithPid(4242)
    spawnMock.mockReturnValue(child)

    const build = runBuild('/src', ['windows'], ['editor'], 'auto', {}, 1)
    await jest.advanceTimersByTimeAsync(1000)

    expect(spawnMock).toHaveBeenCalledWith('scons', expect.any(Array), {
      cwd: '/src',
      stdio: 'inherit',
      detached: false
    })
    expect(processKill).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')

    child.emit('exit', null, 'SIGTERM')
    await expect(build).resolves.toBeUndefined()
  })
})

// ── Regression: stray entries in the working directory (BUG3) ────────────────

describe('downloadAndExtract – stray entries in the working directory', () => {
  beforeEach(() => {
    tcDownloadTool.mockResolvedValue('/tmp/godot.tar.xz')
    tcExtractTar.mockResolvedValue('/work')
  })

  it('ignores a dangling symlink that is not a godot-* entry', async () => {
    fsReaddirSync.mockReturnValue(['stale-link', 'godot-4.4-stable', 'README'])
    fsStatSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('stale-link')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return { isDirectory: () => !String(p).endsWith('README') }
    })

    await expect(downloadAndExtract('4.4', 'stable', '/work')).resolves.toBe(
      '/work/godot-4.4-stable'
    )
    // Only godot-* entries are stat'ed at all.
    expect(fsStatSync).toHaveBeenCalledTimes(1)
    expect(fsStatSync).toHaveBeenCalledWith('/work/godot-4.4-stable')
  })

  it('treats a dangling godot-* symlink as "not a directory"', async () => {
    fsReaddirSync.mockReturnValue(['godot-3.6-stable', 'godot-4.4-stable'])
    fsStatSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('godot-3.6-stable')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return { isDirectory: () => true }
    })

    // The dangling link is not a candidate, so there is exactly one match.
    await expect(downloadAndExtract('4.5', 'stable', '/work')).resolves.toBe(
      '/work/godot-4.4-stable'
    )
  })
})

// ── Regression: exit-code message names the 3.x target (BUG4) ────────────────

describe('spawnWithTimeout – exit-code message for Godot 3.x', () => {
  it('names platform, tools and target for a 3.x build', async () => {
    spawnMock.mockImplementation(() => makeFakeChild(255))

    await expect(
      runBuild(
        '/src',
        ['linuxbsd'],
        ['editor'],
        'x86_64',
        { optimize: 'size' },
        0,
        undefined,
        3
      )
    ).rejects.toThrow(
      new Error(
        'Build exited with code 255 (platform=x11 tools=yes target=release_debug)'
      )
    )
  })

  it('distinguishes two 3.x targets that share platform and tools', async () => {
    spawnMock.mockImplementation(() => makeFakeChild(1))
    const messages: string[] = []
    for (const target of ['template_debug', 'template_release']) {
      await runBuild(
        '/src',
        ['macos'],
        [target],
        'auto',
        {},
        0,
        undefined,
        3
      ).catch((e: Error) => messages.push(e.message))
    }
    expect(messages).toEqual([
      'Build exited with code 1 (platform=osx tools=no target=release_debug)',
      'Build exited with code 1 (platform=osx tools=no target=release)'
    ])
  })
})

// ── Regression: symlinks in the header walk (BUG5) ───────────────────────────

describe('createHeaderArchive – symbolic links', () => {
  it('exposes the collected header extensions', () => {
    expect(HEADER_EXTENSIONS).toEqual([
      '.glsl',
      '.h',
      '.hh',
      '.hpp',
      '.inc',
      '.inl'
    ])
  })

  it('follows a symlinked header file and archives it under the link name', async () => {
    fsReaddirSync.mockImplementation((dir: unknown) =>
      dir === '/src' ? [makeDirent('link.h', 'symlink')] : []
    )
    fsStatSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true
    })

    await createHeaderArchive('/src')

    expect(fsStatSync).toHaveBeenCalledWith('/src/link.h')
    expect(admZipInstance.addLocalFile).toHaveBeenCalledWith('/src/link.h', '')
  })

  it('walks a symlinked directory', async () => {
    fsReaddirSync.mockImplementation((dir: unknown) => {
      if (dir === '/src') return [makeDirent('linked_dir', 'symlink')]
      if (dir === '/src/linked_dir') return [makeDirent('b.h', 'file')]
      return []
    })
    fsStatSync.mockReturnValue({
      isDirectory: () => true,
      isFile: () => false
    })
    fsRealpathSync.mockImplementation((p: unknown) =>
      p === '/src/linked_dir' ? '/elsewhere/real_dir' : String(p)
    )

    await createHeaderArchive('/src')

    expect(admZipInstance.addLocalFile).toHaveBeenCalledWith(
      '/src/linked_dir/b.h',
      'linked_dir'
    )
  })

  it('skips a dangling symlink instead of failing', async () => {
    fsReaddirSync.mockImplementation((dir: unknown) =>
      dir === '/src'
        ? [makeDirent('dangling.h', 'symlink'), makeDirent('a.h', 'file')]
        : []
    )
    fsStatSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    await createHeaderArchive('/src')

    expect(admZipInstance.addLocalFile.mock.calls.map((c) => c[0])).toEqual([
      '/src/a.h'
    ])
  })

  it('ignores a symlink to something that is neither a file nor a directory', async () => {
    fsReaddirSync.mockImplementation((dir: unknown) =>
      dir === '/src' ? [makeDirent('socket.h', 'symlink')] : []
    )
    fsStatSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => false
    })

    await createHeaderArchive('/src')

    expect(admZipInstance.addLocalFile).not.toHaveBeenCalled()
  })

  it('visits each real directory once so link cycles terminate', async () => {
    // /src/core/loop -> /src (a cycle); /src/core/a.h must be archived once.
    fsReaddirSync.mockImplementation((dir: unknown) => {
      if (dir === '/src') return [makeDirent('core', 'dir')]
      if (dir === '/src/core') {
        return [makeDirent('a.h', 'file'), makeDirent('loop', 'symlink')]
      }
      return []
    })
    fsStatSync.mockReturnValue({
      isDirectory: () => true,
      isFile: () => false
    })
    fsRealpathSync.mockImplementation((p: unknown) =>
      p === '/src/core/loop' ? '/src' : String(p)
    )

    await createHeaderArchive('/src')

    expect(fsReaddirSync).toHaveBeenCalledTimes(2)
    expect(fsReaddirSync).not.toHaveBeenCalledWith('/src/core/loop', {
      withFileTypes: true
    })
    expect(admZipInstance.addLocalFile).toHaveBeenCalledTimes(1)
    expect(admZipInstance.addLocalFile).toHaveBeenCalledWith(
      '/src/core/a.h',
      'core'
    )
  })
})
