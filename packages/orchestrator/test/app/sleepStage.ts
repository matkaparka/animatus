/**
 * Makes a `FakeStage` answer `sleep.*` the way the real page does. `fake-stage.ts` is not touched: this listens on the
 * same socket (`fake.stage.ws`) and sends its own reports, so a test can use the fake stage for everything else.
 */
import type { RawData } from 'ws'
import type { FakeStage } from '../_stage-support/fake-stage.ts'
import {
  DEFAULT_SLEEP_STAGE,
  SleepStageModel,
  type SleepMessage,
  type SleepStageOpts,
} from '../modes/sleepStageModel.ts'

export interface SleepProbe {
  /** Every `sleep.*` message the page received, in order. */
  readonly received: SleepMessage[]
  readonly model: SleepStageModel
  ofType(type: string): SleepMessage[]
}

export function answerSleep(fake: FakeStage, opts: Partial<SleepStageOpts> = {}): SleepProbe {
  const received: SleepMessage[] = []
  const model = new SleepStageModel({ ...DEFAULT_SLEEP_STAGE, ...opts }, (m) => {
    if (fake.stage.ws.readyState === 1) fake.stage.send(m)
  })
  fake.stage.ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) return
    const text = (Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)).toString('utf8')
    const msg = JSON.parse(text) as SleepMessage
    if (!msg.type.startsWith('sleep.')) return
    received.push(msg)
    model.handle(msg)
  })
  fake.stage.ws.on('close', () => model.reset())
  return { received, model, ofType: (type) => received.filter((m) => m.type === type) }
}
