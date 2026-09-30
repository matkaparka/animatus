import { defineConfig } from 'vitest/config'

// Each package under packages/ may carry its own vitest config; this runs them all.
export default defineConfig({
  test: {
    projects: ['packages/*', 'tools/*'],
  },
})
