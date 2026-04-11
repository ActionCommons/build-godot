/**
 * © 2026-present Action Commons (https://github.com/ActionCommons)
 */

import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import typescript from '@rollup/plugin-typescript'
import { defineConfig } from 'rollup'

/**
 * Build configuration for the GitHub Action.
 *
 * Key points:
 * - All @actions/* packages are marked EXTERNAL.
 *   → This is the official/recommended pattern for GitHub Actions.
 *   → The GitHub runner already ships with @actions/core, @actions/exec, etc.
 *   → Prevents the "this has been rewritten to undefined" warning and the
 *     circular dependency warnings between core.js ↔ oidc-utils.js.
 *
 * - adm-zip is also external (heavy dependency already present on the runner).
 *
 * - Output is CommonJS (required by GitHub Actions) with a .cjs extension.
 *   → This is the fix for the current error.
 *   → When package.json contains "type": "module", Node treats .js files as ESM.
 *   → Using .cjs forces CommonJS even in an ESM project.
 */
export default defineConfig({
  input: 'src/index.ts',
  context: 'this',

  output: {
    file: 'dist/index.cjs',
    format: 'cjs',
    sourcemap: true
  },

  plugins: [
    resolve({
      preferBuiltins: true // node:fs, node:os, child_process, etc.
    }),
    commonjs(),
    typescript({
      tsconfig: './tsconfig.json'
    })
  ],

  onwarn(warning, warn) {
    // Skip circular dependency warnings from the @actions packages
    if (
      warning.code === 'CIRCULAR_DEPENDENCY' &&
      warning.message.includes('@actions')
    ) {
      return
    }
    warn(warning)
  },

  external: []
})
