/** The code of each mode, by id. A mode pack without an entry here is listed by the console as "no code for this mode yet". */
import type { ControllerFactory } from '../host.ts'
import { createDanceController } from './dance.ts'
import { createDrawController } from './draw.ts'

export const builtinControllers: Readonly<Record<string, ControllerFactory>> = {
  dance: createDanceController,
  draw: (host) => createDrawController(host),
}
