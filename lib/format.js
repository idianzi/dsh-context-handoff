/**
 * Plain-text command reports. The UI renders these as the `/handoff` result;
 * they deliberately stay short enough to read in a chat transcript.
 *
 * @module dsh-context-handoff/format
 */
import { describeVerdict, formatPercent, formatTokens, formatTurns } from './economics.js'
import { fileReference } from './digest.js'
import { displayPath } from './files.js'

/** Help text for `/handoff help`. */
export const HELP_TEXT = [
  'Usage:',
  '  /handoff                 Write a handoff now and report the token trade-off.',
  '  /handoff plan [turns]    Compare continuing with writing a handoff; no model call.',
  '  /handoff status          Show the latest handoff for this workspace.',
  '  /handoff list            List the newest handoff files.',
  '  /handoff stats           Aggregate the local handoff ledger.',
  '  /handoff auto [on|off]   Show or set the per-workspace auto switch.',
  '  /handoff now [tokens]    Write a handoff with an explicit digest budget.',
  '  /handoff help            Show this help.',
  '',
  'Examples:',
  '  /handoff plan 12',
  '  /handoff now 4000',
].join('\n')

/**
 * Format the cost comparison.
 * @param {object} input
 * @param {ReturnType<import('./economics.js').computePlan>} input.plan
 * @param {object} input.config
 * @param {number} input.digestBudget
 * @param {object} [input.extra]
 * @returns {string}
 */
export function formatPlanReport({ plan, config, digestBudget, extra }) {
  const lines = []
  if (extra?.sessionTokens !== undefined) {
    lines.push(`Session so far: ${formatTokens(extra.sessionTokens)} tokens across ${extra.turns ?? '?'} user turns (${formatTokens(extra.perTurn)}/turn).`)
  }
  const windowText =
    plan.windowTokens === undefined
      ? 'window unknown'
      : `${formatTokens(plan.promptTokens)} / ${formatTokens(plan.windowTokens)} (${formatPercent(plan.pressureRatio)}), ${formatTokens(plan.headroomTokens)} headroom`
  lines.push(`Context: ${windowText}`)
  lines.push(`Composition: ${formatTokens(plan.fixedPrefixTokens)} fixed prefix + ${formatTokens(plan.messageTokens)} messages`)
  lines.push(`Digest: ${formatTokens(plan.digestTokens)} tokens (budget ${formatTokens(digestBudget)})`)
  if (plan.useful) {
    lines.push(
      `Per-turn saving: ${formatTokens(plan.savingPerTurn)} tokens (cache factor ${plan.cacheFactor.toFixed(2)}) · break-even ${formatTurns(plan.breakEvenTurns)} turns`,
    )
    lines.push(
      `Over ${plan.horizonTurns} turns: ${plan.projectedSavings >= 0 ? 'saves' : 'costs'} ${formatTokens(Math.abs(plan.projectedSavings))} tokens after paying for the summary`,
    )
  } else {
    lines.push('Per-turn saving: none — the digest is not smaller than the current message budget.')
  }
  lines.push('')
  lines.push(describeVerdict(plan))
  if (Number.isFinite(plan.recommendedAt)) {
    const suffix = plan.windowTokens === undefined ? '' : ` (${Math.round((plan.recommendedAt / plan.windowTokens) * 100)}% of window)`
    lines.push(`Recommendation point: ${formatTokens(plan.recommendedAt)} tokens${suffix}`)
  }
  if (Number.isFinite(plan.economicAt)) {
    lines.push(`Earliest efficient point: ${formatTokens(plan.economicAt)} tokens over ${plan.horizonTurns} turns`)
  }
  if (plan.tokensToRecommended !== undefined && plan.tokensToRecommended > 0) {
    lines.push(`Next checkpoint: ${formatTokens(plan.tokensToRecommended)} tokens of growth away`)
  }
  lines.push(`Cache assumption: ${formatPercent(config.cacheHitRatio)} hit, cache-read weight ${config.cacheReadWeight}`)
  return lines.join('\n')
}

/**
 * Format a completed handoff.
 * @param {object} input
 * @param {string} input.relativePath
 * @param {string} input.cwd
 * @param {object} input.plan
 * @param {number} input.digestTokens
 * @param {number} input.budgetTokens
 * @param {string} input.generator - llm or fallback
 * @param {boolean} input.truncated
 * @param {string} [input.fallbackReason]
 * @param {string} [input.language]
 * @param {string} [input.summaryMode]
 * @param {number} [input.omittedMessages]
 * @param {string} [input.newSessionId]
 * @param {string} [input.sessionError]
 * @returns {string}
 */
export function formatGeneratedReport({ relativePath, cwd, plan, digestTokens, budgetTokens, generator, truncated, fallbackReason, language, summaryMode, omittedMessages, newSessionId, sessionError }) {
  const lines = []
  lines.push(`Handoff written: ${relativePath}`)
  lines.push(
    `Digest: ${formatTokens(digestTokens)} / ${formatTokens(budgetTokens)} tokens · generator: ${generator}${truncated ? ' (middle trimmed)' : ''}`,
  )
  lines.push(
    `Source context: ${formatTokens(plan.promptTokens)} tokens${plan.windowTokens === undefined ? '' : ` / ${formatTokens(plan.windowTokens)} (${formatPercent(plan.pressureRatio)})`}`,
  )
  if (plan.useful) {
    lines.push(`Saves ~${formatTokens(plan.savingPerTurn)}/turn; break-even ${formatTurns(plan.breakEvenTurns)} turns; ${plan.horizonTurns}-turn projection ${plan.projectedSavings >= 0 ? '+' : '-'}${formatTokens(Math.abs(plan.projectedSavings))}`)
  }
  if (fallbackReason !== undefined) lines.push(`Fallback reason: ${fallbackReason}`)
  if (summaryMode === 'transcript') {
    lines.push(`Summary used a budgeted transcript${omittedMessages > 0 ? ` with ${omittedMessages} messages omitted` : ''}.`)
  }
  const nextHeading = language === 'zh' ? '下一步' : 'Next steps'
  lines.push('')
  lines.push(`Start a new session in ${cwd} and send:`)
  lines.push(`Read ${fileReference(relativePath)} and continue from the "${nextHeading}" section.`)
  return lines.join('\n')
}

/**
 * Format the latest-file status.
 * @param {object} input
 * @param {string} input.cwd
 * @param {object | undefined} input.latest
 * @param {object} input.plan
 * @param {number} input.digestBudget
 * @param {object} input.config
 * @returns {string}
 */
export function formatStatusReport({ cwd, latest, plan, digestBudget, config }) {
  const lines = []
  if (latest === undefined) {
    lines.push('No handoff files in this workspace yet. Run /handoff to create one.')
  } else {
    const ageMinutes = Math.max(0, Math.round((Date.now() - latest.mtimeMs) / 60000))
    lines.push(`Latest: ${displayPath(cwd, latest.path)}`)
    lines.push(
      `Written ${ageMinutes} min ago · ${formatTokens(Number(latest.meta.digest_tokens) || 0)} digest tokens · source ${formatTokens(Number(latest.meta.source_tokens) || 0)}`,
    )
  }
  lines.push('')
  lines.push(formatPlanReport({ plan, config, digestBudget }))
  lines.push('')
  lines.push(formatConfigSummary(config))
  return lines.join('\n')
}

/**
 * Format the newest files.
 * @param {Array<{path: string, mtimeMs: number, meta: object}>} files
 * @param {string} cwd
 * @param {number} [limit]
 * @returns {string}
 */
export function formatListReport(files, cwd, limit = 10) {
  if (files.length === 0) return 'No handoff files in this workspace yet.'
  const lines = [`Handoff files (${files.length} total):`]
  for (const file of files.slice(0, limit)) {
    const rel = displayPath(cwd, file.path)
    const date = localStamp(file.mtimeMs)
    lines.push(
      `- ${date}  ${rel}  ${formatTokens(Number(file.meta.digest_tokens) || 0)} digest / ${formatTokens(Number(file.meta.source_tokens) || 0)} source`,
    )
  }
  if (files.length > limit) lines.push(`… and ${files.length - limit} more`)
  return lines.join('\n')
}

/**
 * Aggregate the ledger into a compact report.
 * @param {object} input
 * @param {object[]} input.records
 * @param {number} input.fileCount
 * @param {object | undefined} input.usage - current session projection state.
 * @returns {string}
 */
function localStamp(mtimeMs) {
  const date = new Date(mtimeMs)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatStatsReport({ records, fileCount, usage }) {
  const lines = [`Handoff ledger: ${records.length} recorded generation${records.length === 1 ? '' : 's'} · ${fileCount} file${fileCount === 1 ? '' : 's'} on disk.`]
  if (records.length > 0) {
    const sum = (key) => records.reduce((total, record) => total + (Number(record[key]) || 0), 0)
    const summaryTokens = sum('summary_tokens')
    const projectedSaved = sum('projected_saved_tokens')
    const sourceTokens = sum('source_tokens')
    const breakEvens = records.map((record) => Number(record.break_even_turns)).filter((value) => Number.isFinite(value) && value > 0)
    const averageBreakEven = breakEvens.length === 0 ? undefined : breakEvens.reduce((a, b) => a + b, 0) / breakEvens.length
    lines.push(`Summarized context: ${formatTokens(sourceTokens)} source tokens`)
    lines.push(`Summary cost: ${formatTokens(summaryTokens)} tokens (actual/effective)`)
    lines.push(`Projected saving: ${projectedSaved >= 0 ? '+' : '-'}${formatTokens(Math.abs(projectedSaved))} tokens over the configured horizons`)
    if (averageBreakEven !== undefined) lines.push(`Average break-even: ${formatTurns(averageBreakEven)} turns`)
  }
  if (usage !== undefined) {
    const input = (Number(usage.uncachedInputTokens) || 0) + (Number(usage.cacheReadTokens) || 0) + (Number(usage.cacheWriteTokens) || 0)
    lines.push('')
    lines.push(
      `Current session spend: ${formatTokens(input)} input (${formatTokens(Number(usage.cacheReadTokens) || 0)} from cache) + ${formatTokens(Number(usage.outputTokens) || 0)} output.`,
    )
  }
  return lines.join('\n')
}

/**
 * Convert a config object into a short human summary for `/handoff status`.
 * @param {object} config
 * @returns {string}
 */
export function formatConfigSummary(config) {
  return [
    `digest target ${formatTokens(config.targetDigestTokens)} · ratio ${formatPercent(config.digestRatio)}`,
    `recommend at ${formatPercent(config.recommendAtRatio)} of window · horizon ${config.horizonTurns} turns`,
    `auto ${config.auto ? 'on' : 'off'} · output ${config.outputDir}`,
  ].join(' · ')
}
