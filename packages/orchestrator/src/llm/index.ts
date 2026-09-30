/**
 * The LLM gateway of the orchestrator: providers (Gemini, OpenAI-compatible), fallback order,
 * cooldowns, usage statistics and secret redaction.
 *
 * ```ts
 * const gateway = new LlmGateway({
 *   providers: [
 *     createLlmProvider({ kind: 'gemini', id: 'primary', apiKey, model, proxy: 'http://127.0.0.1:7897' }),
 *     createLlmProvider({ kind: 'openai-compatible', id: 'local', baseUrl: 'http://127.0.0.1:8081/v1', model }),
 *   ],
 *   order: ['primary', 'local'],
 * })
 * for await (const delta of gateway.stream({ messages, tag: 'chat' })) { ... }
 * ```
 */
import { GeminiProvider } from './gemini.ts'
import type { GeminiConfig } from './gemini.ts'
import { LlmConfigError } from './http.ts'
import { OpenAiProvider } from './openai.ts'
import type { OpenAiConfig } from './openai.ts'
import type { LlmProvider } from './types.ts'

export * from './types.ts'
export { LlmGateway, DEFAULT_COOLDOWN_MS } from './gateway.ts'
export type {
  LlmCooldownConfig,
  LlmGatewayOptions,
  LlmGatewayStats,
  LlmLogLevel,
  LlmLogger,
  LlmProviderStats,
  LlmTagStats,
} from './gateway.ts'
export { GeminiProvider, GEMINI_DEFAULT_BASE_URL, classifyGeminiHttp } from './gemini.ts'
export type { GeminiConfig } from './gemini.ts'
export { OpenAiProvider, classifyOpenAiHttp } from './openai.ts'
export type { OpenAiConfig } from './openai.ts'
export { LlmConfigError } from './http.ts'
export { REDACTED, Redactor, redactSecrets, secretsFromUrl } from './redact.ts'
export { SseParser } from './sse.ts'
export type { SseEvent } from './sse.ts'

/** One entry of `llm.providers` after the secrets were resolved. */
export type LlmProviderConfig =
  ({ kind: 'gemini' } & GeminiConfig) | ({ kind: 'openai-compatible' } & OpenAiConfig)

/** Build a provider from a resolved configuration entry. Throws `LlmConfigError` for a bad entry. */
export function createLlmProvider(config: LlmProviderConfig): LlmProvider {
  switch (config.kind) {
    case 'gemini':
      return new GeminiProvider(config)
    case 'openai-compatible':
      return new OpenAiProvider(config)
    default:
      throw new LlmConfigError(
        `unknown LLM provider kind '${String((config as { kind?: unknown }).kind)}'`
      )
  }
}
