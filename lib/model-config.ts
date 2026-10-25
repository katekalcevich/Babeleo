// Centralized model configuration for the conversation route.
//
// Why this exists: reasoning-effort and verbosity support differ per model family, and passing an
// unsupported parameter makes the OpenAI Responses API reject the whole request. Instead of a single
// broad model-name regex sprinkled through the route, we resolve capabilities from a small registry
// here so behaviour is explicit, safe for unknown models, and easy to extend when benchmarking a new
// model.
//
// Production model policy: the app uses process.env.OPENAI_MODEL when set, otherwise the documented
// fallback below. Changing the fallback here is the ONLY way the production model changes — it never
// changes silently. To benchmark another model, set OPENAI_MODEL (no code change needed); to make a
// new default permanent, update DEFAULT_MODEL and add its capabilities to MODEL_CAPABILITIES.

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'
export type Verbosity = 'low' | 'medium' | 'high'

// Documented production fallback when OPENAI_MODEL is unset.
export const DEFAULT_MODEL = 'gpt-5-mini'

// Bumped whenever the stable instruction/profile prefix changes, so prompt-cache keys don't collide
// across incompatible prompt versions.
export const PROMPT_PROFILE_VERSION = 'v1'

export type ModelConfig = {
  model: string
  family: string
  // Lowest reasoning effort appropriate for short casual dialogue, or undefined if unsupported.
  reasoningEffort?: ReasoningEffort
  // Concise output request, or undefined if the model doesn't support verbosity.
  verbosity?: Verbosity
  supportsPromptCacheKey: boolean
}

type Capabilities = Omit<ModelConfig, 'model'>

// Prefix-matched capability registry. Order matters: the first matching prefix wins.
const MODEL_CAPABILITIES: { prefix: RegExp; caps: Capabilities }[] = [
  // GPT-5 family: supports reasoning.effort down to 'minimal' and text.verbosity. 'minimal' effort
  // gets the first token out fastest, which dominates perceived latency on casual chat.
  { prefix: /^gpt-5/, caps: { family: 'gpt-5', reasoningEffort: 'minimal', verbosity: 'low', supportsPromptCacheKey: true } },
  // o-series reasoning models: support reasoning.effort but NOT 'minimal' (lowest is 'low') and NOT
  // verbosity.
  { prefix: /^o\d/, caps: { family: 'o-series', reasoningEffort: 'low', supportsPromptCacheKey: true } },
  // GPT-4.1 / 4o / 4-turbo: no reasoning effort, no verbosity knob.
  { prefix: /^gpt-4/, caps: { family: 'gpt-4', supportsPromptCacheKey: true } },
]

// Safe default for unknown models: send no optional tuning params so the request can't be rejected.
const UNKNOWN_CAPABILITIES: Capabilities = { family: 'unknown', supportsPromptCacheKey: false }

export function resolveModelConfig(model = process.env.OPENAI_MODEL || DEFAULT_MODEL): ModelConfig {
  const match = MODEL_CAPABILITIES.find((entry) => entry.prefix.test(model))
  return { model, ...(match ? match.caps : UNKNOWN_CAPABILITIES) }
}

// Stable prompt-cache key derived from the applicable profile configuration (which cats are in the
// stable prefix) plus the prompt version. Keeping it independent of the dynamic message/history lets
// OpenAI reuse the cached stable prefix across requests. The app still works when the option is
// unavailable — the route only attaches it when supportsPromptCacheKey is true.
export function promptCacheKey(profileConfigId: string) {
  return `babeleo-${PROMPT_PROFILE_VERSION}-${profileConfigId}`
}
