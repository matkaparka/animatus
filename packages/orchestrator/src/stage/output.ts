import type { BeginArgs, EndReason, StageOutput, StageReports } from '../speech/director.ts'
import type { StageHub } from './hub.ts'

/** The slice of `StageHub` the speech director needs, so tests can stand in for the hub. */
export type HubLike = Pick<
  StageHub,
  'connected' | 'beginUtterance' | 'cancelUtterance' | 'cancelAll' | 'on' | 'off'
>

/** What the speech director sends to the stage, expressed as calls on the hub. */
export function stageOutput(hub: HubLike): StageOutput {
  return {
    get connected() {
      return hub.connected
    },
    async beginUtterance(args: BeginArgs, media) {
      const r = await hub.beginUtterance(
        {
          utterance_id: args.utterance_id,
          seq: args.seq,
          turn_id: args.turn_id,
          emotion: args.emotion,
          motion: args.motion,
          audio: { sample_rate: args.audio.sample_rate, total_samples: args.audio.total_samples },
          ...(args.subtitle !== undefined ? { subtitle: args.subtitle } : {}),
        },
        // live_motion is derived by the hub from the presence of a stream.
        media.vrma ? { pcm16: media.pcm16, vrma: media.vrma } : { pcm16: media.pcm16 }
      )
      return { cancelled: r.cancelled }
    },
    cancel(scope, utteranceId, fadeMs) {
      const opts = fadeMs === undefined ? {} : { fadeMs }
      if (scope === 'all') hub.cancelAll(opts)
      else if (utteranceId) hub.cancelUtterance(utteranceId, opts)
    },
  }
}

/** What the stage reports back about playback, as the speech director wants to hear it. */
export function stageReports(hub: HubLike): StageReports {
  return {
    on(event, fn): () => void {
      switch (event) {
        case 'started': {
          const h = (m: { utterance_id: string }) => (fn as (id: string) => void)(m.utterance_id)
          hub.on('playback.started', h)
          return () => void hub.off('playback.started', h)
        }
        case 'ended': {
          const h = (m: { utterance_id: string; reason: EndReason }) =>
            (fn as (id: string, r: EndReason) => void)(m.utterance_id, m.reason)
          hub.on('playback.ended', h)
          return () => void hub.off('playback.ended', h)
        }
        case 'disconnected': {
          const h = () => (fn as () => void)()
          hub.on('disconnected', h)
          return () => void hub.off('disconnected', h)
        }
      }
    },
  }
}
