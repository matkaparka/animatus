export interface AdapterInfo {
  /** Counter-style id, e.g. luid_0x00000000_0x000122ab (lowercase). */
  luid: string
  name: string
  /** PCI vendor id as 0xNNNN (0x10de NVIDIA, 0x1002 AMD, 0x8086 Intel, 0x1414 Microsoft). */
  vendor: string
  dedicated_mb: number
  /** DXGI_ADAPTER_FLAG bits; 2 = software adapter. */
  flags: number
}

export interface ProcInfo {
  pid: number
  ppid?: number
  name?: string
  cmd?: string
  /** The process was already gone when the collector looked it up. */
  gone?: boolean
}

/** One line from the collector, parsed. */
export interface RawSample {
  t: number
  /** MiB of dedicated memory in use, by adapter luid. */
  adapters: Record<string, number>
  procs: { pid: number; luid: string; mb: number }[]
}

export interface ProcEntry {
  pid: number
  role: string
  mb: number
  name?: string
}

/** One second of the recording, attributed. */
export interface Sample {
  t: number
  elapsed_s: number
  /** Dedicated memory in use on the target adapter (adapter counter), MiB. */
  target_mb: number
  /** nvidia-smi memory.used for cross-checking, MiB. */
  nvsmi_mb: number | null
  /** MiB in use on every other adapter, by adapter name. */
  other_gpus_mb: Record<string, number>
  /** Sum of process memory on the target adapter by role; unclassified processes are under "other". */
  roles: Record<string, number>
  /** Processes on the target adapter holding at least the minimum. */
  procs: ProcEntry[]
  /** Configured roles that hold memory on a non-target adapter: adapter name -> role -> MiB. */
  roles_off_target: Record<string, Record<string, number>>
}

export interface Mark {
  t: number
  elapsed_s: number
  label: string
}

export interface MetaRecord {
  type: 'meta'
  started_at: string
  label: string
  interval_s: number
  adapters: AdapterInfo[]
  target: AdapterInfo | null
  roles: Record<string, unknown>
}

export type LogRecord =
  | MetaRecord
  | ({ type: 'sample' } & Sample)
  | ({ type: 'mark' } & Mark)
  | { type: 'proc'; pid: number; name?: string; cmd?: string }

/** The shape of @animatus/protocol's VramMeasurement, kept structural so this package has no dependencies. */
export interface Measurement {
  key: string
  config_hash: string
  peak_mb: number
  steady_mb: number
  measured_at: string
  note?: string
}
