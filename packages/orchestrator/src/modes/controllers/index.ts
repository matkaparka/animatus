/** The code of each mode, by id. A mode pack without an entry here is listed by the console as "no code for this mode yet". */
import type { ControllerFactory } from '../host.ts'
import { createCommentaryController } from './commentary.ts'
import { createDanceController } from './dance.ts'

export const builtinControllers: Readonly<Record<string, ControllerFactory>> = {
  commentary: createCommentaryController,
  dance: createDanceController,
}
