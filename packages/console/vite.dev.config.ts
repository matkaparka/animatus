import { mergeConfig } from 'vite'
import base from './vite.config.ts'

/**
 * Development with hot reload. From `packages/console`:
 *
 *   npx vite --config vite.dev.config.ts
 *
 * The console server refuses cross-origin requests and never sends CORS headers, so this dev server (on
 * http://127.0.0.1:5174) forwards `/api`, the live socket included, to the console server. The console
 * server has to accept this page's origin: pass `extraOrigins: ['http://127.0.0.1:5174']` when it is created
 * (the demo reads ANIMATUS_CONSOLE_EXTRA_ORIGINS for that). Then open the console at the dev server's own
 * address with the token in the fragment: http://127.0.0.1:5174/#token=<token>
 *
 * ANIMATUS_CONSOLE_URL points the forwarding at a console server that is not on 127.0.0.1:7411.
 */
const target = process.env.ANIMATUS_CONSOLE_URL ?? 'http://127.0.0.1:7411'

export default mergeConfig(base, {
  server: {
    proxy: {
      // `changeOrigin` rewrites Host to the target's, which the console server requires; Origin is passed on as is.
      '/api': { target, changeOrigin: true, ws: true },
    },
  },
})
