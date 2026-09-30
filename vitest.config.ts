import { defineConfig } from 'vitest/config'

// Each package under packages/ may carry its own vitest config; this runs them all.
// tools/ holds loose scripts too, so only the directories that carry tests are listed.
export default defineConfig({
  test: {
    projects: ['packages/*', 'tools/secret-scan', 'tools/asset-scan', 'tools/license-audit'],
  },
})
