# Contributing

Thank you for helping maintain `build-godot`. This document covers everything
you need to develop, test, build, and release the action.

## Prerequisites

- **Node.js 24** (the version in `.node-version`). If you use
  [`nodenv`](https://github.com/nodenv/nodenv) or
  [`fnm`](https://github.com/Schniz/fnm), the `.node-version` file will switch
  automatically when you `cd` into the repository.
- **npm** (bundled with Node.js).
- **Python 3** with `pip3` available on `PATH` (used at action runtime to
  install SCons; not required for local development or testing).

## Local setup

```bash
git clone https://github.com/ActionCommons/build-godot.git
cd build-godot
npm install
```

## Project layout

```text
src/
  index.ts      Entrypoint — imports and calls run()
  main.ts       Action logic — reads inputs, validates them, calls godot
                helpers, sets outputs
  godot.ts      All build logic — pure helpers (parseMultiInput, parseOptions,
                buildDownloadUrl, buildSconsArgs) and side-effectful functions
                (downloadAndExtract, setupScons, runBuild, spawnWithTimeout,
                createHeaderArchive)
__tests__/
  main.test.ts  Integration-style tests for run() with mocked I/O and mocked
                godot helpers
  godot.test.ts Unit tests for every exported function in godot.ts; side
                effects are isolated by mocking @actions/tool-cache,
                @actions/exec, @actions/glob, adm-zip, and child_process
__fixtures__/
  core.ts       Jest mock for @actions/core
  godot.ts      Jest mock for src/godot.ts (stubs side-effectful functions
                while re-exporting pure helpers directly)
dist/           Compiled output — committed to the repository (see Releasing)
action.yml      Action metadata: inputs, outputs, branding, runtime
```

## Day-to-day commands

| Task                             | Command                |
| -------------------------------- | ---------------------- |
| Format code                      | `npm run format:write` |
| Check formatting without writing | `npm run format:check` |
| Lint                             | `npm run lint`         |
| Run tests                        | `npm test`             |
| Run tests (CI mode)              | `npm run ci-test`      |
| Build `dist/`                    | `npm run package`      |
| Format + lint + test + build     | `npm run all`          |
| Run action locally               | `npm run local-action` |

Always run `npm run all` before opening a pull request or cutting a release. It
catches formatting, lint, test, and build issues in one pass.

## Running the action locally

The [`@github/local-action`](https://github.com/github/local-action) tool
simulates the GitHub Actions Toolkit so you can run the action from your
terminal without pushing anything.

1. Copy the example env file and fill in your values:

   ```bash
   cp .env.example .env
   ```

1. Set your inputs in `.env` using the `INPUT_<n>` convention:

   ```bash
   ACTIONS_STEP_DEBUG=true
   INPUT_VERSION=4.4
   INPUT_FLAVOR=stable
   INPUT_PLATFORM=linuxbsd
   INPUT_TARGET=editor
   INPUT_ARCHITECTURE=auto
   INPUT_OPTIONS=
   INPUT_TIMEOUT=0
   ```

1. Run the action:

   ```bash
   npm run local-action
   # equivalent to: npx @github/local-action . src/main.ts .env
   ```

> [!CAUTION] Never commit a real `.env` file. It is listed in `.gitignore`, but
> double-check before staging files.

## Writing tests

Tests live in `__tests__/` and use [Jest](https://jestjs.io/) with ESM support.

**`main.test.ts`** mocks both `@actions/core` and `src/godot.ts` so the tests
exercise the wiring logic (input validation, output naming, error propagation)
without touching the filesystem, network, or real processes.

**`godot.test.ts`** tests every exported function. Pure helpers
(`parseMultiInput`, `parseOptions`, `buildDownloadUrl`, `buildSconsArgs`) are
called directly. Side-effectful functions are tested by mocking their
dependencies (`@actions/tool-cache`, `@actions/exec`, `@actions/glob`,
`adm-zip`, `child_process`) via `jest.unstable_mockModule`.

### Key patterns

```typescript
// Always declare mocks BEFORE importing the module under test.
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('../src/godot.js', () => godot)

// Then import dynamically so the mocks are active.
const { run } = await import('../src/main.js')
```

> [!IMPORTANT] ES module exports are read-only. **Never** use `jest.spyOn` to
> replace an exported function — it throws
> `Cannot assign to read only property`. Mock the underlying dependency instead.
> For example, to control `spawnWithTimeout`, mock `child_process`:
>
> ```typescript
> const spawnMock = jest.fn()
> jest.unstable_mockModule('child_process', () => ({ spawn: spawnMock }))
> ```

`jest.resetAllMocks()` clears mock implementations **and** return values set at
declaration time. Always re-apply `mockReturnValue` / `mockResolvedValue` calls
inside `beforeEach`, not at the top level, so they survive between tests.

## Adding a new input

1. Add the input to `action.yml` with a description and `required: false`.
1. Read it in `src/main.ts` with `core.getInput('your-new-input')`.
1. Add validation logic and, if the input affects the SCons invocation, thread
   it through to `src/godot.ts`.
1. Add test cases in `__tests__/main.test.ts` (happy path + validation error).
1. Update the inputs table in `README.md`.

## Adding a new build option

Build options are parsed in `parseOptions` inside `src/godot.ts` and threaded
through `buildSconsArgs` into the SCons command line.

1. Add the new token to `parseOptions` with appropriate validation.
1. Pass it through `buildSconsArgs` as a SCons argument.
1. Add unit tests in `__tests__/godot.test.ts` covering both the happy path and
   any invalid-value error paths.
1. Document the new flag in the `options` input description in `action.yml` and
   in the Options table in `README.md`.

## Continuous integration

All pull requests and pushes to `main` run three workflows automatically:

| Workflow                                             | What it checks                                 |
| ---------------------------------------------------- | ---------------------------------------------- |
| **CI** (`.github/workflows/ci.yml`)                  | Lint, tests, coverage                          |
| **Check dist/** (`.github/workflows/check-dist.yml`) | `dist/` matches the source after a clean build |
| **CodeQL** (`.github/workflows/codeql-analysis.yml`) | Static security analysis                       |

The **Check dist/** workflow will fail if you forget to rebuild before pushing.
Running `npm run all` before committing prevents this.

### Dependency licence checking

The `licensed.yml` workflow is disabled by default. To enable it, uncomment the
`pull_request` and `push` triggers in `.github/workflows/licensed.yml`. Once
enabled, update the licence cache whenever you add or upgrade a dependency:

```bash
licensed cache   # update cached licence data
licensed status  # check for missing or non-compliant licences
```

## Building

The build compiles `src/` into the single self-contained file `dist/index.js`
using [Rollup](https://rollupjs.org/):

```bash
npm run package
```

Two warnings from `@actions/core` are expected and harmless — they originate
inside the package itself and are not a sign of a problem in this codebase:

- `"this" has been rewritten to "undefined"` — a CommonJS/ESM interop quirk.
- `Circular dependency` — a known cycle inside `@actions/core`.

To suppress them in output, add an `onwarn` handler to `rollup.config.ts`:

```typescript
onwarn(warning, warn) {
  if (warning.code === 'THIS_IS_UNDEFINED') return
  if (warning.code === 'CIRCULAR_DEPENDENCY') return
  warn(warning)
}
```

> [!IMPORTANT] `dist/index.js` must be committed to the repository. GitHub
> Actions fetches it directly at runtime — it does not run `npm install` or
> `npm run build`.

## Releasing

The repository includes a helper script that handles tagging:

```bash
bash script/release
```

The script will:

1. Detect the latest SemVer tag on the current branch.
1. Prompt you for the new tag (format `vX.Y.Z`).
1. Tag the new release and update the floating major tag (e.g. `v1`).
1. Push commits, tags, and any new `releases/v#` branch to remote.

After the script finishes, go to **Releases** on GitHub and draft a new release
against the tag you just pushed. This is what makes the version appear on the
Marketplace.

### Manual release steps (if not using the script)

```bash
# 1. Build and verify everything is clean
npm run all

# 2. Commit the compiled dist/
git add dist/
git commit -m "Build for release vX.Y.Z"

# 3. Create a precise version tag
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z

# 4. Update (or create) the floating major tag
git tag -fa v1 -m "Update v1 to vX.Y.Z"
git push origin v1 --force
```

### Semantic versioning conventions

| Change type                                                 | Version bump | Example             |
| ----------------------------------------------------------- | ------------ | ------------------- |
| Bugfix, docs, refactor                                      | Patch        | `v1.0.0` → `v1.0.1` |
| New input, new option, new behaviour (backwards-compatible) | Minor        | `v1.0.0` → `v1.1.0` |
| Removed input, breaking output format change                | Major        | `v1.x.x` → `v2.0.0` |

When cutting a new major version, update `README.md` to reference `@v2` in all
usage examples.

## Code owners

Update [`CODEOWNERS`](./CODEOWNERS) to reflect the current maintainers. The file
controls who is auto-requested for review on pull requests.
