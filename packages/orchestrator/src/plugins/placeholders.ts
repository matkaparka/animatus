import { isAbsolute, resolve } from 'node:path'
import type { RuntimeEnv } from '@animatus/protocol'
import type { ProcessRuntime } from './registry.ts'

/** Interpreter paths of the shared Python dependency groups (`runtime.env: light` and `audio`). */
export interface Interpreters {
  light: string
  audio?: string
}

/** The part of a manifest's `secrets` entry the resolver needs. */
export interface SecretDeclaration {
  name: string
  required?: boolean
}

export interface PlaceholderContext {
  /** `runtime.env` of the manifest: decides what `{python}` means. */
  env: RuntimeEnv
  pluginDir: string
  dataDir: string
  /** The port this launch uses; `{port}` is an error while it is undefined. */
  port?: number
  /** The plugin's own settings. */
  config: Readonly<Record<string, unknown>>
  interpreters: Interpreters
  /** The manifest's `secrets` list. Only these names can be referenced. */
  declaredSecrets: readonly SecretDeclaration[]
  /** Values fetched from the secret store for the declared names. `undefined` means not set. */
  secrets: Readonly<Record<string, string | undefined>>
}

/** Where a template sits. Secrets are only accepted in `env`: a secret on a command line is visible to everyone. */
export type PlaceholderSlot = 'command' | 'cwd' | 'env'

/**
 * A placeholder that cannot be resolved. The message names the placeholder (`{config.root}`,
 * `${secret:gemini}`) and where it was used; it never contains a resolved value.
 */
export class PlaceholderError extends Error {
  readonly placeholder: string
  readonly where: string

  constructor(message: string, placeholder: string, where: string) {
    super(`${where}: ${message} (${placeholder})`)
    this.name = 'PlaceholderError'
    this.placeholder = placeholder
    this.where = where
  }
}

function lookup(config: Readonly<Record<string, unknown>>, path: string): unknown {
  if (Object.hasOwn(config, path)) return config[path]
  let current: unknown = config
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, part))
      return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function pythonFor(ctx: PlaceholderContext, fail: (reason: string) => never): string {
  switch (ctx.env) {
    case 'light':
      if (!ctx.interpreters.light) return fail('the light Python interpreter is not configured')
      return ctx.interpreters.light
    case 'audio':
      if (!ctx.interpreters.audio) return fail('the audio Python interpreter is not configured')
      return ctx.interpreters.audio
    case 'external': {
      const python = lookup(ctx.config, 'python')
      if (typeof python !== 'string' || python === '') {
        return fail(
          'runtime.env is "external": set config.python to the interpreter of that environment'
        )
      }
      return python
    }
    case 'node':
      return process.execPath
    case 'native':
      return fail(
        'runtime.env is "native": there is no interpreter, put the executable in the command'
      )
  }
}

/**
 * Expands the placeholders of one string.
 *
 *   {port} {python} {plugin_dir} {data_dir} {config.<key>}   `<key>` may be a dotted path
 *   ${config:<key>}                                           the same lookup as {config.<key>}
 *   ${secret:<name>}                                          env_vars only, declared names only
 *
 * Strict: an unknown placeholder, a config key that is not set, an unterminated brace or a required
 * secret that is not set throws a PlaceholderError. `{{` and `}}` are literal braces, and a `$` that
 * is not followed by `{` is literal too. A declared secret that is optional and not set becomes "".
 */
export function resolveTemplate(
  template: string,
  ctx: PlaceholderContext,
  where: string,
  slot: PlaceholderSlot
): string {
  let out = ''
  let i = 0

  const fail =
    (raw: string) =>
    (reason: string): never => {
      throw new PlaceholderError(reason, raw, where)
    }

  const configValue = (path: string, raw: string): string => {
    if (path === '') return fail(raw)('empty config key')
    const value = lookup(ctx.config, path)
    if (value === undefined || value === null) return fail(raw)(`config key "${path}" is not set`)
    if (typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (typeof value === 'boolean') return String(value)
    return fail(raw)(`config key "${path}" is not a string, number or boolean`)
  }

  const secretValue = (name: string, raw: string): string => {
    const declared = ctx.declaredSecrets.find((secret) => secret.name === name)
    if (!declared) return fail(raw)(`secret "${name}" is not listed in the manifest's secrets`)
    if (slot !== 'env') {
      return fail(raw)(
        'secrets are only allowed in env_vars (a secret on a command line shows up in the process list)'
      )
    }
    const value = ctx.secrets[name]
    if (value === undefined) {
      if (declared.required) return fail(raw)(`required secret "${name}" is not set`)
      return ''
    }
    return value
  }

  const expandBrace = (body: string, raw: string): string => {
    switch (body) {
      case 'port':
        if (ctx.port === undefined) return fail(raw)('no port is allocated for this plugin')
        return String(ctx.port)
      case 'python':
        return pythonFor(ctx, fail(raw))
      case 'plugin_dir':
        return ctx.pluginDir
      case 'data_dir':
        return ctx.dataDir
    }
    if (body.startsWith('config.')) return configValue(body.slice('config.'.length), raw)
    return fail(raw)('unknown placeholder')
  }

  const expandDollar = (body: string, raw: string): string => {
    if (body.startsWith('secret:')) return secretValue(body.slice('secret:'.length), raw)
    if (body.startsWith('config:')) return configValue(body.slice('config:'.length), raw)
    return fail(raw)('unknown placeholder')
  }

  while (i < template.length) {
    const ch = template[i]
    if (ch === '$' && template[i + 1] === '{') {
      const end = template.indexOf('}', i + 2)
      if (end < 0) return fail(template.slice(i))('unterminated placeholder')
      out += expandDollar(template.slice(i + 2, end), template.slice(i, end + 1))
      i = end + 1
    } else if (ch === '{') {
      if (template[i + 1] === '{') {
        out += '{'
        i += 2
        continue
      }
      const end = template.indexOf('}', i + 1)
      if (end < 0) return fail(template.slice(i))('unterminated placeholder')
      out += expandBrace(template.slice(i + 1, end), template.slice(i, end + 1))
      i = end + 1
    } else if (ch === '}') {
      if (template[i + 1] !== '}') return fail('}')('a lone "}" (write "}}" for a literal brace)')
      out += '}'
      i += 2
    } else {
      out += ch
      i++
    }
  }
  return out
}

export interface ResolvedProcessRuntime {
  /** argv with every placeholder expanded. */
  command: string[]
  /** Absolute working directory (the plugin directory when the manifest names none). */
  cwd: string
  /** `env_vars` with every placeholder expanded. May contain secret values. */
  envVars: Record<string, string>
}

/** Resolves `command`, `cwd` and `env_vars` of a process runtime. */
export function resolveProcessRuntime(
  runtime: ProcessRuntime,
  ctx: PlaceholderContext
): ResolvedProcessRuntime {
  const command = runtime.command.map((part, index) =>
    resolveTemplate(part, ctx, `runtime.command[${index}]`, 'command')
  )
  if (command[0] === '') {
    throw new PlaceholderError(
      'the executable resolved to an empty string',
      runtime.command[0] ?? '',
      'runtime.command[0]'
    )
  }
  const rawCwd =
    runtime.cwd === undefined
      ? ctx.pluginDir
      : resolveTemplate(runtime.cwd, ctx, 'runtime.cwd', 'cwd')
  const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(ctx.pluginDir, rawCwd)
  const envVars: Record<string, string> = {}
  for (const [key, value] of Object.entries(runtime.env_vars)) {
    envVars[key] = resolveTemplate(value, ctx, `runtime.env_vars.${key}`, 'env')
  }
  return { command, cwd, envVars }
}
