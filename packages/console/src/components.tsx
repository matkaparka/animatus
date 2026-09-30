import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ModeState, PluginStatus } from '@animatus/protocol'
import { ApiClientError } from './api.ts'

export type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'info'

/** A small coloured label. Colour is never the only carrier of meaning: the text says it too. */
export function Pill({
  tone = 'idle',
  children,
  title,
}: {
  tone?: Tone
  children: ReactNode
  title?: string
}) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      {children}
    </span>
  )
}

/** A message line. Errors are announced (`role="alert"`), the rest are polite. */
export function Notice({ kind, children }: { kind: 'error' | 'ok' | 'info'; children: ReactNode }) {
  return (
    <p className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  )
}

export function Card({
  title,
  tone,
  children,
}: {
  title: string
  tone?: Tone
  children: ReactNode
}) {
  return (
    <section className={`card${tone ? ` card-${tone}` : ''}`}>
      <h3 className="card-title">{title}</h3>
      {children}
    </section>
  )
}

export function pluginTone(status: PluginStatus): Tone {
  switch (status) {
    case 'ready':
      return 'ok'
    case 'starting':
    case 'stopping':
    case 'unhealthy':
      return 'warn'
    case 'failed':
      return 'bad'
    default:
      return 'idle'
  }
}

export function modeTone(state: ModeState): Tone {
  switch (state) {
    case 'ACTIVE':
      return 'ok'
    case 'STARTING':
    case 'STOPPING':
      return 'warn'
    default:
      return 'idle'
  }
}

/** What to show for a failed call. The server's own message when there is one. */
export function messageOf(err: unknown): string {
  if (err instanceof ApiClientError) return err.message
  return 'Something went wrong.'
}

/**
 * Runs an async action and tracks whether it is in flight and what went wrong. `run` resolves to the
 * action's result, or undefined when it failed (the error is then in `error`).
 */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError(null)
    try {
      return await action()
    } catch (err) {
      if (alive.current) setError(messageOf(err))
      return undefined
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [])
  const clear = useCallback(() => setError(null), [])
  return { busy, error, run, clear }
}
