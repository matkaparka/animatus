import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', target: 'es2022', sourcemap: true },
  server: { host: '127.0.0.1', port: 5174 },
  test: {
    name: 'console',
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'happy-dom',
    testTimeout: 20000,
  },
})
