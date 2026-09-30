import { installAudioContextCounter } from './audio/counter.ts'
import { Stage } from './stage.ts'

// Must run before anything creates an AudioContext.
installAudioContextCounter()

const canvas = document.getElementById('stage') as HTMLCanvasElement
const overlaysRoot = document.getElementById('overlays') as HTMLElement
const backdropRoot = document.getElementById('backdrop') as HTMLElement

// The stage takes no local input: no keyboard handlers, no menus, no pointer interaction.
window.addEventListener('contextmenu', (e) => e.preventDefault())

// `?ws=` points the stage at another orchestrator (development). Nothing else is read from the URL.
const params = new URLSearchParams(location.search)
const wsUrl =
  params.get('ws') ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stage`

new Stage({ canvas, overlaysRoot, backdropRoot, wsUrl }).start()
