import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['__tests__/unit/**/*.test.js', '__tests__/e2e/**/*.test.js'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
