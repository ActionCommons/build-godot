# build-godot

![CI](https://github.com/ActionCommons/build-godot/actions/workflows/ci.yml/badge.svg)
![Check dist/](https://github.com/ActionCommons/build-godot/actions/workflows/check-dist.yml/badge.svg)
![CodeQL](https://github.com/ActionCommons/build-godot/actions/workflows/codeql-analysis.yml/badge.svg)
![Coverage](https://raw.githubusercontent.com/ActionCommons/build-godot/main/badges/coverage.svg)

A GitHub Action that downloads a specific version of the Godot game engine
source and builds it via SCons for one or more target platforms. Both Godot 4.x
and Godot 3.x (3.5 and newer) are supported; the major version is detected from
the `version` input. See [Building Godot 3.x](#building-godot-3x) for details.

## Usage

### Build the editor for the host platform

```yaml
steps:
  - name: Checkout
    uses: actions/checkout@v4

  - name: Build Godot editor
    id: godot
    uses: ActionCommons/build-godot@v1
    with:
      version: '4.4'
      platform: linuxbsd
      target: editor

  - name: Show build directory
    run: echo "${{ steps.godot.outputs.directory }}"
```

### Build export templates for multiple platforms

```yaml
- name: Build export templates
  id: godot
  uses: ActionCommons/build-godot@v1
  with:
    version: '4.4'
    flavor: stable
    platform: |
      linuxbsd
      windows
    target: |
      template_debug
      template_release
    architecture: x86_64
```

A separate SCons invocation is run for every `platform` × `target` combination,
so the example above produces four builds.

### Build an iOS export template with simulator support

```yaml
- name: Build Godot iOS templates
  id: godot
  uses: ActionCommons/build-godot@v1
  with:
    version: '4.4'
    platform: ios
    target: template_release
    architecture: arm64
    options: |
      generate_bundle=yes
      ios_simulator=yes
```

### Build with debug symbols and include a header archive

```yaml
- name: Build Godot with headers
  id: godot
  uses: ActionCommons/build-godot@v1
  with:
    version: '4.4'
    platform: linuxbsd
    target: editor
    options: |
      debug_symbols=yes
      create_header_archive

- name: Upload headers
  uses: actions/upload-artifact@v7
  with:
    name: godot-headers
    path: ${{ steps.godot.outputs.header_archive }}
```

### Build a prerelease version with a timeout

```yaml
- name: Build Godot beta
  uses: ActionCommons/build-godot@v1
  with:
    version: '4.5'
    flavor: beta2
    platform: linuxbsd
    target: editor
    timeout: '3600'
```

### Build Godot 3.x export templates

The same input names are used for Godot 3.x; the action translates them into the
arguments the Godot 3 build tool expects (see
[Building Godot 3.x](#building-godot-3x)).

```yaml
- name: Build Godot 3.6 templates
  uses: ActionCommons/build-godot@v1
  with:
    version: '3.6'
    platform: linuxbsd
    target: 'template_debug, template_release'
    architecture: x86_64
```

## Inputs

| Input          | Required | Default      | Description                                                                                                                                                                                                                                                                                                                        |
| -------------- | :------: | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`      | **Yes**  | —            | Godot version to build, e.g. `4.4`, `4.6.1` or `3.6`. Use `MAJOR.MINOR` or `MAJOR.MINOR.PATCH` without a `.0` patch (`4.4`, not `4.4.0`). The major version (3 or 4) is detected from this value; see [Building Godot 3.x](#building-godot-3x).                                                                                    |
| `flavor`       |    No    | `stable`     | Release flavor: `stable`, or `devN`, `alphaN`, `betaN`, `rcN` (e.g. `dev1`, `beta2`, `rc1`). Lowercase only.                                                                                                                                                                                                                       |
| `directory`    |    No    | _(temp dir)_ | Working directory for the build. A unique temporary directory is created when left empty.                                                                                                                                                                                                                                          |
| `timeout`      |    No    | `0`          | Wall-clock timeout in seconds for the **whole** build (all `platform` × `target` combinations together). When reached, the running SCons process is killed and the remaining combinations are skipped. Must be a plain integer from `0` to `2147483`; `0` means no timeout.                                                        |
| `platform`     | **Yes**  | —            | Target platform(s), comma- or newline-separated. Allowed: `android`, `ios`, `linuxbsd`, `macos`, `web`, `windows`. Repeated values are ignored. Translated automatically for Godot 3.x.                                                                                                                                            |
| `target`       | **Yes**  | —            | Build target(s), comma- or newline-separated. Allowed: `editor`, `template_debug`, `template_release`. Repeated values are ignored. `editor` is rejected for `ios`, and for `android` on Godot 3.x. Translated automatically for Godot 3.x.                                                                                        |
| `architecture` |    No    | `auto`       | CPU architecture passed as `arch=` to SCons. Allowed: `auto`, `x86_32`, `x86_64`, `arm32`, `arm64`, `rv64`, `ppc32`, `ppc64`, `wasm32`. `auto` lets SCons detect the host architecture. Each platform only accepts the architectures it can build (see [Input validation](#input-validation)); Godot 3.x accepts a smaller subset. |
| `options`      |    No    | _(empty)_    | Extra build options, comma- or newline-separated. See [Options](#options) below.                                                                                                                                                                                                                                                   |

## Outputs

| Output           | Always set | Description                                                                                                                                                 |
| ---------------- | :--------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `directory`      |    Yes     | Absolute path to the working directory used for the build.                                                                                                  |
| `header_archive` |     No     | Absolute path to a ZIP of all `*.glsl`, `*.h`, `*.hh`, `*.hpp`, `*.inc`, and `*.inl` files. Only set when `create_header_archive` is included in `options`. |

## Options

The `options` input accepts one or more of the following flags, comma- or
newline-separated:

| Flag                                                       | Description                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_header_archive`                                    | After the build completes, ZIP every `*.glsl`, `*.h`, `*.hh`, `*.hpp`, `*.inc`, and `*.inl` file found in the working directory and set the `header_archive` output.                                                                                                                                        |
| `debug_symbols=[yes\|no]`                                  | Control whether debug symbols are included in the compiled binaries. Passed directly as `debug_symbols=` to SCons.                                                                                                                                                                                          |
| `generate_bundle=[yes\|no]`                                | Generate a `.app` bundle after compilation. Only accepted when every `platform` is `macos` or `ios`. Passed directly as `generate_bundle=` to SCons. Godot 4.x only.                                                                                                                                        |
| `ios_simulator=[yes\|no]`                                  | Build for the iOS Simulator instead of a physical device. Only accepted when `platform` is `ios`. Passed directly as `ios_simulator=` to SCons.                                                                                                                                                             |
| `optimize=[speed_trace\|speed\|size\|debug\|none\|custom]` | Set the compiler optimisation level. Passed directly as `optimize=` to SCons. See the [Godot build tool docs](https://docs.godotengine.org/en/stable/contributing/development/compiling/introduction_to_the_buildsystem.html) for what each level means. Godot 3.x only accepts `speed`, `size` and `none`. |

## Building Godot 3.x

The action's inputs use the Godot 4.x vocabulary for every version. When the
`version` input starts with `3.`, the action detects a Godot 3.x build and
translates the inputs into the arguments the Godot 3 build tool understands. You
do **not** use the native 3.x names (`x11`, `osx`, `javascript`, `iphone`,
`tools=yes`, `bits=64`, …) in the workflow; pass the 4.x names and the action
translates them:

| Input                                            | Godot 4.x SCons arguments     | Godot 3.x SCons arguments                                                                                                      |
| ------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `platform: linuxbsd`                             | `platform=linuxbsd`           | `platform=x11`                                                                                                                 |
| `platform: macos`                                | `platform=macos`              | `platform=osx`                                                                                                                 |
| `platform: web`                                  | `platform=web`                | `platform=javascript`                                                                                                          |
| `platform: ios`                                  | `platform=ios`                | `platform=iphone`                                                                                                              |
| `platform: windows` / `android`                  | unchanged                     | unchanged                                                                                                                      |
| `target: editor`                                 | `target=editor`               | `tools=yes target=release_debug`                                                                                               |
| `target: template_debug`                         | `target=template_debug`       | `tools=no target=release_debug`                                                                                                |
| `target: template_release`                       | `target=template_release`     | `tools=no target=release`                                                                                                      |
| `architecture: x86_32` / `x86_64`                | `arch=x86_32` / `arch=x86_64` | `bits=32` / `bits=64` (`linuxbsd`, `windows`); `android_arch=x86` / `android_arch=x86_64` (`android`); `arch=x86_64` (`macos`) |
| `architecture: arm32` / `arm64`                  | `arch=arm32` / `arch=arm64`   | `android_arch=armv7` / `android_arch=arm64v8` (`android`); `arch=arm64` (`macos`, `ios`)                                       |
| `architecture: rv64`, `ppc32`, `ppc64`, `wasm32` | `arch=…`                      | **rejected** – no Godot 3.x equivalent                                                                                         |
| `architecture: auto`                             | _(omitted)_                   | _(omitted)_ – SCons detects the host                                                                                           |
| `optimize=speed` / `size` / `none`               | passed through                | passed through                                                                                                                 |
| `optimize=speed_trace` / `debug` / `custom`      | passed through                | **rejected**                                                                                                                   |
| `debug_symbols=…`, `ios_simulator=…`             | passed through                | passed through                                                                                                                 |
| `generate_bundle=…`                              | passed through                | **rejected** – Godot 3.x builds app bundles via the scripts in `misc/dist`                                                     |
| `create_header_archive`                          | handled by the action         | handled by the action                                                                                                          |

Inputs that cannot be expressed for Godot 3.x fail the step immediately, before
any source is downloaded, with an error that names the input and the supported
alternatives. This also applies to `target: editor` with `android` or `ios`:
Godot 3.x has no editor build for either.

Other 3.x specifics:

- **Supported range:** Godot 3.5 and newer. Older 3.x releases need toolchains
  (compilers, Emscripten, Android NDK) that current GitHub-hosted runners no
  longer provide. The action accepts any `3.*` version but logs a warning for
  releases older than 3.5, which are untested.
- **SCons version:** Godot 3.x build scripts are not compatible with the latest
  SCons releases, so the action installs `scons<4.8` for 3.x builds. Godot 4.x
  builds keep installing the latest SCons.
- **Linux system packages:** Godot 4.x loads X11, OpenGL and audio libraries at
  runtime, so `platform: linuxbsd` builds need no extra packages. Godot 3.x
  links against them at build time, so install the development headers before
  the action runs, otherwise SCons aborts with `X11 libraries not found`:

  ```yaml
  - name: Install Godot 3.x build dependencies
    run: |
      sudo apt-get update
      sudo apt-get install -y --no-install-recommends \
        libx11-dev libxcursor-dev libxinerama-dev libxi-dev libxrandr-dev \
        libgl1-mesa-dev libglu1-mesa-dev libasound2-dev libpulse-dev libudev-dev
  ```

- **Output binaries:** Godot 3.x produces differently named binaries (for
  example `bin/godot.x11.opt.tools.64`). The `directory` output points at the
  working directory in both cases.

## Input validation

All inputs are validated before anything is downloaded, so a mistake fails the
step in seconds with an error naming the input:

- **Architecture per platform:** only the architectures each platform's SCons
  detector supports are accepted.

  | Platform   | Godot 4.x                                                      | Godot 3.x                            |
  | ---------- | -------------------------------------------------------------- | ------------------------------------ |
  | `android`  | `x86_32`, `x86_64`, `arm32`, `arm64`                           | `x86_32`, `x86_64`, `arm32`, `arm64` |
  | `ios`      | `x86_64`, `arm64`                                              | `arm64`                              |
  | `linuxbsd` | `x86_32`, `x86_64`, `arm32`, `arm64`, `rv64`, `ppc32`, `ppc64` | `x86_32`, `x86_64`                   |
  | `macos`    | `x86_64`, `arm64`                                              | `x86_64`, `arm64`                    |
  | `web`      | `wasm32`                                                       | `auto` only                          |
  | `windows`  | `x86_32`, `x86_64`, `arm32`, `arm64`                           | `x86_32`, `x86_64`                   |

  `auto` is accepted everywhere.

- **Editor builds:** `target: editor` is rejected for `ios` (no iOS editor
  exists) and, for Godot 3.x, also for `android`.
- **Platform-specific options:** `ios_simulator` requires every `platform` to be
  `ios`; `generate_bundle` requires `macos` or `ios`.
- **Conflicting options:** the same option with two different values (for
  example `optimize=speed, optimize=size`) is rejected. Identical repeats, like
  repeated platforms or targets, are ignored.
- **Formats:** `version`, `flavor` and `timeout` must match the formats in
  [Inputs](#inputs) exactly; for example `timeout: 1.5` or `timeout: 10abc` is
  rejected rather than truncated.

If the working `directory` already contains other `godot-*` source trees (for
example from a cache), the action uses the one matching `version` and `flavor`.
If none matches and there is more than one, it fails instead of guessing.

## How it works

1. **Detect** — reads the major version (3 or 4) from the `version` input and
   validates that every other input can be expressed for that version.
1. **Download** — fetches the Godot source tarball for the requested
   `version`-`flavor` combination from
   `https://github.com/godotengine/godot-builds/releases`.
1. **Extract** — unpacks the `.tar.xz` archive into the working directory.
1. **Set up SCons** — installs SCons via `pip3` (pinned to `scons<4.8` for Godot
   3.x).
1. **Build** — runs `scons platform=<p> target=<t> [arch=…] [options…]` once for
   every `platform` × `target` pair. For Godot 3.x the arguments are translated
   first (see [Building Godot 3.x](#building-godot-3x)).
1. **Header archive** _(optional)_ — if `create_header_archive` is set, collects
   all header files into a ZIP and sets the `header_archive` output.

## Testing locally

Copy `.env.example` to `.env` and set your input values, then run:

```bash
npx @github/local-action . src/main.ts .env
```

Input names follow the `INPUT_<NAME>` convention:

```bash
# .env
ACTIONS_STEP_DEBUG=true
INPUT_VERSION=4.4
INPUT_FLAVOR=stable
INPUT_PLATFORM=linuxbsd
INPUT_TARGET=editor
INPUT_ARCHITECTURE=auto
INPUT_OPTIONS=
INPUT_TIMEOUT=0
```

## Other useful `npm` commands

### Setup packages defined in the `package.json` file

```bash
npm install
```

### Update packages

Update packages to the latest version allowed by the version range specified in
the `package.json` file.

```bash
npm update
```

### Check for vulnerabilities

```bash
npm audit
```

### Check the registry for newer versions

Check the registry to see if any of the installed packages have newer versions
available.

```bash
npm outdated
```

### Prune

Remove "extraneous" packages—those that are installed in node_modules but no
longer listed in `package.json`

```bash
npm prune
```

### Simplify the dependency tree

Simplify the dependency tree by moving duplicated nested dependencies further up
the hierarchy.

```bash
npm dedupe
```

### Display package dependencies

Display an ASCII tree of all installed packages and their dependencies.

```bash
npm list (or npm ls)
npm ls -g --depth=0   # to see only top-level global packages
```

### Display dependency chain

Check why a specific package is installed by visualizing the dependency chain
leading to it.

```bash
npm explain <package> (formerly npm why)
```

### Run diagnostic tests

Run a series of diagnostic tests to ensure the npm installation and environment
(like the cache and registry access) are working correctly.

```bash
npm doctor
```

### Clear cache

Clear the internal npm cache, which can resolve "ghost" installation errors.

```bash
npm cache clean --force
```

### Continuous Integration

Perform a "clean" install by deleting node_modules and strictly following the
`package-lock.json` file (Designed for CI environments).

```bash
npm ci
```

### Create a symbolic link

Create a symbolic link for a package being developed locally, allowing use in
another project as if it were published.

```bash
npm link
```

### Print detailed metadata about a package

Print detailed metadata about a package from the registry without installing it,
such as available versions or its documentation.

```bash
npm view <package-name>
```
