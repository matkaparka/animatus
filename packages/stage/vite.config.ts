import { defineConfig } from 'vitest/config'

export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    // Never inline assets as data: URLs: the stage's Content-Security-Policy does not allow them for
    // scripts (an AudioWorklet module below the default 4 KB limit would otherwise be inlined and refused).
    assetsInlineLimit: 0,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  test: {
    name: 'stage',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
})
