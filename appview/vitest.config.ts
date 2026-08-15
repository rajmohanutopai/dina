import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    /**
     * TEST WHAT SHIPS.
     *
     * appview is the only component that COMPILES — everything else in the
     * workspace runs TypeScript source through `tsx`. So `@dina/commerce-protocol`
     * exposes a `compiled` condition, and appview's runtime asks for it
     * (`node --conditions=compiled` in the Dockerfile).
     *
     * Without this line the tests would resolve the package's `default`
     * condition — its TypeScript SOURCE — while production loads the build.
     * The two are generated from the same file, so they would almost always
     * agree, and "almost always" is the whole problem: a suite green against
     * one artifact while a different artifact ships is the defect this
     * dependency was adopted to remove, not a new place to reintroduce it.
     */
    conditions: ['compiled'],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
    fileParallelism: false,
    reporters: process.env.VITEST_JSON ? ['json'] : ['verbose'],
    outputFile: process.env.VITEST_JSON ? 'test-results.json' : undefined,
  },
})
