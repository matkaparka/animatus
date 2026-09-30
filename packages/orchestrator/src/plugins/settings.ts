import type { PluginManifest } from '@animatus/protocol'

/** A setting the manifest requires and the configuration leaves out. */
export interface MissingSetting {
  key: string
  /** What it is for, from the manifest (description, else title); empty when the manifest says nothing. */
  about: string
}

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * The settings a plugin needs (`config_schema.required` in its manifest) that its configuration leaves out or empty.
 * A setting the manifest gives a `default` is not missing. Without this check the plugin fails later, with a message
 * about a placeholder in its command line.
 */
export function missingSettings(
  manifest: Pick<PluginManifest, 'config_schema'>,
  config: Readonly<Record<string, unknown>>
): MissingSetting[] {
  const schema = asRecord(manifest.config_schema)
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : []
  const properties = asRecord(schema.properties)
  const missing: MissingSetting[] = []
  for (const key of required) {
    if (isSet(config[key])) continue
    const property = asRecord(properties[key])
    if (isSet(property.default)) continue
    const about = [property.description, property.title].find(
      (text): text is string => typeof text === 'string' && text.trim() !== ''
    )
    missing.push({ key, about: about ?? '' })
  }
  return missing
}

/** One line that names what is missing, in the words of the configuration file; null when nothing is. */
export function describeMissingSettings(
  id: string,
  manifest: Pick<PluginManifest, 'config_schema'>,
  config: Readonly<Record<string, unknown>>
): string | null {
  const missing = missingSettings(manifest, config)
  if (missing.length === 0) return null
  return missing
    .map(
      (m) =>
        `plugins.${id}.config.${m.key} is not set${m.about ? `: ${m.about.replace(/\.$/, '')}` : ''}`
    )
    .join('; ')
}
