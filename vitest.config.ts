import { defineConfig } from 'vitest/config'

// Each package under packages/ may carry its own vitest config; this runs them all.
// tools/ holds loose scripts too, so only the directories that carry tests are listed.
export default defineConfig({
  test: {
    // Many of the orchestrator's tests start real processes (git, Python services, a web server) and wait for them with
    // deadlines. On a machine with dozens of cores the default of one worker per core makes those deadlines fail now and then
    // for no fault of the code, so the run is spread over fewer workers.
    maxWorkers: 8,
    projects: ['packages/*', 'tools/secret-scan', 'tools/asset-scan', 'tools/license-audit'],
  },
})
