/** Which client speaks to the game agent, by the mode's settings. */
import { LegacyLinkClient, WorkerClient } from '../../workers/index.ts'
import type { WorkerApi } from '../../workers/index.ts'
import type { GameSettings } from './settings.ts'

/** A client for the agent at `url`, with `timeoutMs` for every call. `name` is what the worker must be (worker protocol) or what the game is called (older link). */
export function makeWorkerClient(
  cfg: Pick<GameSettings, 'protocol' | 'name'>,
  url: string,
  timeoutMs: number
): WorkerApi {
  return cfg.protocol === 'legacy'
    ? new LegacyLinkClient({ baseUrl: url, timeoutMs, worker: cfg.name ?? 'game' })
    : new WorkerClient({
        baseUrl: url,
        timeoutMs,
        ...(cfg.name !== undefined ? { expect: cfg.name } : {}),
      })
}
