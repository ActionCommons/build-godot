# build-godot

![CI](https://github.com/ActionCommons/build-godot/actions/workflows/ci.yml/badge.svg)
![Check dist/](https://github.com/ActionCommons/build-godot/actions/workflows/check-dist.yml/badge.svg)
![CodeQL](https://github.com/ActionCommons/build-godot/actions/workflows/codeql-analysis.yml/badge.svg)
![Coverage](https://raw.githubusercontent.com/ActionCommons/build-godot/main/badges/coverage.svg)

A GitHub Action that downloads a specific version of the Godot game engine
source and builds it via SCons for one or more target platforms.

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

## Inputs

| Input          | Required | Default      | Description                                                                                                                                                                             |
| -------------- | :------: | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`      | **Yes**  | —            | Godot version to build, e.g. `4.4` or `3.6`.                                                                                                                                            |
| `flavor`       |    No    | `stable`     | Release flavor: `stable`, `dev1`, `beta2`, `rc1`, etc.                                                                                                                                  |
| `directory`    |    No    | _(temp dir)_ | Working directory for the build. A unique temporary directory is created when left empty.                                                                                               |
| `timeout`      |    No    | `0`          | Wall-clock timeout in seconds. The build process is killed after this many seconds. `0` means no timeout.                                                                               |
| `platform`     | **Yes**  | —            | Target platform(s), comma- or newline-separated. Allowed: `android`, `ios`, `linuxbsd`, `macos`, `web`, `windows`.                                                                      |
| `target`       | **Yes**  | —            | Build target(s), comma- or newline-separated. Allowed: `editor`, `template_debug`, `template_release`.                                                                                  |
| `architecture` |    No    | `auto`       | CPU architecture passed as `arch=` to SCons. Allowed: `auto`, `x86_32`, `x86_64`, `arm32`, `arm64`, `rv64`, `ppc32`, `ppc64`, `wasm32`. `auto` lets SCons detect the host architecture. |
| `options`      |    No    | _(empty)_    | Extra build options, comma- or newline-separated. See [Options](#options) below.                                                                                                        |

## Outputs

| Output           | Always set | Description                                                                                                                                                 |
| ---------------- | :--------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `directory`      |    Yes     | Absolute path to the working directory used for the build.                                                                                                  |
| `header_archive` |     No     | Absolute path to a ZIP of all `*.glsl`, `*.h`, `*.hh`, `*.hpp`, `*.inc`, and `*.inl` files. Only set when `create_header_archive` is included in `options`. |

## Options

The `options` input accepts one or more of the following flags, comma- or
newline-separated:

| Flag                                                       | Description                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_header_archive`                                    | After the build completes, ZIP every `*.glsl`, `*.h`, `*.hh`, `*.hpp`, `*.inc`, and `*.inl` file found in the working directory and set the `header_archive` output.                                                                                     |
| `debug_symbols=[yes\|no]`                                  | Control whether debug symbols are included in the compiled binaries. Passed directly as `debug_symbols=` to SCons.                                                                                                                                       |
| `optimize=[speed_trace\|speed\|size\|debug\|none\|custom]` | Set the compiler optimisation level. Passed directly as `optimize=` to SCons. See the [Godot build tool docs](https://docs.godotengine.org/en/stable/contributing/development/compiling/introduction_to_the_buildsystem.html) for what each level means. |

## How it works

1. **Download** — fetches the Godot source tarball for the requested
   `version`-`flavor` combination from
   `https://github.com/godotengine/godot-builds/releases`.
1. **Extract** — unpacks the `.tar.xz` archive into the working directory.
1. **Set up SCons** — installs SCons via `pip3`.
1. **Build** — runs `scons platform=<p> target=<t> [arch=…] [options…]` once for
   every `platform` × `target` pair.
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
