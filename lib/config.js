/**
 * Configuration schema and cross-field validation for dsh-context-handoff.
 *
 * DSH validates an entry's `config` with `static Config` before constructing
 * the plugin. `resolveConfig()` then applies the small number of rules that a
 * flat schema cannot express (ordering, ratios, paired provider/model fields).
 *
 * @module dsh-context-handoff/config
 */
import Schema from '@deepseek-ai/schemastery'

/** Defaults shared by the schema, the bundle patch, and documentation. */
export const DEFAULTS = Object.freeze({
  outputDir: '.dsh/handoff',
  targetDigestTokens: 3000,
  minDigestTokens: 700,
  maxDigestTokens: 8000,
  digestRatio: 0.03,
  recommendAtRatio: 0.55,
  recommendMaxTokens: 256000,
  horizonTurns: 8,
  cacheHitRatio: 0.5,
  cacheReadWeight: 0.1,
  switchOverheadTokens: 1500,
  keepFiles: 20,
  auto: false,
  autoNewSession: true,
  autoMinGrowthTokens: 8000,
  autoCooldownMinutes: 10,
  provider: '',
  model: '',
  maxOutputTokens: 0,
  language: 'auto',
  includeToolDetails: true,
  transcriptBudgetRatio: 0.7,
  redactSecrets: true,
  fallbackDigest: true,
  ledger: true,
})

const nonNegativeInteger = Schema.number().step(1).min(0)
const positiveInteger = Schema.number().step(1).min(1)

/**
 * Cordis-facing config schema. Every field is optional and defaulted so a
 * profile can override just one value without restating the rest.
 */
export const Config = Schema.object({
  outputDir: Schema.string()
    .default(DEFAULTS.outputDir)
    .description('Directory for handoff files, relative to the session workspace (or absolute).'),
  targetDigestTokens: positiveInteger
    .default(DEFAULTS.targetDigestTokens)
    .description('Upper token budget for the generated Markdown handoff.'),
  minDigestTokens: positiveInteger
    .default(DEFAULTS.minDigestTokens)
    .description('Lower bound used when the current context is still small.'),
  maxDigestTokens: positiveInteger
    .default(DEFAULTS.maxDigestTokens)
    .description('Absolute cap for a digest, even when digestRatio asks for more.'),
  digestRatio: Schema.number()
    .min(0.005)
    .max(0.25)
    .default(DEFAULTS.digestRatio)
    .description('Share of the current context spent on the handoff (clamped by min/max/target).'),
  recommendAtRatio: Schema.number()
    .min(0.05)
    .max(1)
    .default(DEFAULTS.recommendAtRatio)
    .description('Context-window fraction at which a handoff is recommended for quality reasons.'),
  recommendMaxTokens: nonNegativeInteger
    .default(DEFAULTS.recommendMaxTokens)
    .description('Absolute cap for the recommendation point; 0 disables the cap.'),
  horizonTurns: Schema.number()
    .step(1)
    .min(2)
    .default(DEFAULTS.horizonTurns)
    .description('Turns a new session is assumed to run when comparing costs; at least 2.'),
  cacheHitRatio: Schema.number()
    .min(0)
    .max(1)
    .default(DEFAULTS.cacheHitRatio)
    .description('Assumed share of the prompt served from the provider cache on later turns.'),
  cacheReadWeight: Schema.number()
    .min(0)
    .max(1)
    .default(DEFAULTS.cacheReadWeight)
    .description('Relative cost of one cache-read token versus one uncached input token.'),
  switchOverheadTokens: nonNegativeInteger
    .default(DEFAULTS.switchOverheadTokens)
    .description('Extra re-orientation cost charged to starting a new session.'),
  keepFiles: nonNegativeInteger
    .default(DEFAULTS.keepFiles)
    .description('Maximum handoff files kept per output directory (0 disables pruning).'),
  auto: Schema.boolean()
    .default(DEFAULTS.auto)
    .description('Default for new workspaces; the sidebar switch stores a per-workspace override.'),
  autoNewSession: Schema.boolean()
    .default(DEFAULTS.autoNewSession)
    .description('When auto mode fires, create a new session from the handoff and queue the resume prompt.'),
  autoMinGrowthTokens: nonNegativeInteger
    .default(DEFAULTS.autoMinGrowthTokens)
    .description('Minimum context growth before auto mode writes another handoff.'),
  autoCooldownMinutes: nonNegativeInteger
    .default(DEFAULTS.autoCooldownMinutes)
    .description('Minimum minutes between two automatic handoffs for one session.'),
  provider: Schema.string()
    .default(DEFAULTS.provider)
    .description('Optional summarization provider; empty uses the routed/agent model.'),
  model: Schema.string()
    .default(DEFAULTS.model)
    .description('Optional summarization model; empty uses the routed/agent model.'),
  maxOutputTokens: nonNegativeInteger
    .default(DEFAULTS.maxOutputTokens)
    .description('Optional output cap for the summarization call (0 lets the plugin derive it).'),
  language: Schema.union(['auto', 'en', 'zh'])
    .default(DEFAULTS.language)
    .description('Handoff language: auto, en, or zh.'),
  includeToolDetails: Schema.boolean()
    .default(DEFAULTS.includeToolDetails)
    .description('Include tool names and short arguments in the summary prompt and fallback digest.'),
  transcriptBudgetRatio: Schema.number()
    .min(0.1)
    .max(0.95)
    .default(DEFAULTS.transcriptBudgetRatio)
    .description('Share of the model window a plain-text fallback transcript may occupy.'),
  redactSecrets: Schema.boolean()
    .default(DEFAULTS.redactSecrets)
    .description('Redact common API keys, tokens, and private keys from the written handoff.'),
  fallbackDigest: Schema.boolean()
    .default(DEFAULTS.fallbackDigest)
    .description('Write a deterministic digest when no model is available or summarization fails.'),
  ledger: Schema.boolean()
    .default(DEFAULTS.ledger)
    .description('Append an anonymous JSONL cost record next to the handoff files.'),
})

const LANGUAGES = new Set(['auto', 'en', 'zh'])

/**
 * Validate cross-field rules and return a frozen, fully populated config.
 * @param {Record<string, unknown>} [input] - validated entry config.
 * @returns {Readonly<typeof DEFAULTS>} effective config.
 */
export function resolveConfig(input = {}) {
  const config = { ...DEFAULTS, ...(input ?? {}) }

  for (const key of Object.keys(input ?? {})) {
    if (!(key in DEFAULTS)) throw new Error(`dsh-context-handoff: unknown config key "${key}"`)
  }
  if (!LANGUAGES.has(config.language)) {
    throw new Error(`dsh-context-handoff: language must be one of auto, en, zh (got ${JSON.stringify(config.language)})`)
  }
  if (config.minDigestTokens > config.targetDigestTokens) {
    throw new Error('dsh-context-handoff: minDigestTokens must not exceed targetDigestTokens')
  }
  if (config.maxDigestTokens < config.targetDigestTokens) {
    throw new Error('dsh-context-handoff: maxDigestTokens must be at least targetDigestTokens')
  }
  if (config.horizonTurns < 2) {
    throw new Error('dsh-context-handoff: horizonTurns must be at least 2 (a one-turn horizon can never repay a summary)')
  }
  if (config.provider.length === 0 !== (config.model.length === 0)) {
    throw new Error('dsh-context-handoff: provider and model must be set together, or both left empty')
  }
  if (config.outputDir.trim().length === 0) {
    throw new Error('dsh-context-handoff: outputDir must not be empty')
  }
  return Object.freeze(config)
}
