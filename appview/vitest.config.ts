import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
    fileParallelism: false,
    reporters: process.env.VITEST_JSON ? ['json'] : ['verbose'],
    outputFile: process.env.VITEST_JSON ? 'test-results.json' : undefined,
  },
})
