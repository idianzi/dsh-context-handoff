/**
 * Token economics for continuing a session versus writing a handoff and
 * starting a new one.
 *
 * The model is intentionally provider-neutral and expressed in *relative*
 * token cost, not money:
 *
 *   P = current prompt pressure (what the next request re-sends)
 *   S = fixed prefix (system prompt + tool schemas) that both paths pay
 *   D = handoff digest tokens (written once, re-read every turn of a new session)
 *   H = turns the comparison looks ahead
 *   a = cache factor for repeated prompt tokens,
 *       a = (1 - cacheHitRatio) + cacheHitRatio * cacheReadWeight
 *
 * Continuing H turns costs roughly H * P * a.
 * Switching costs one summary read (P * a) plus D output, plus H turns of
 * (S + D) * a, plus a configurable re-orientation overhead.
 *
 * Break-even is therefore
 *   R* = (P * a + D + overhead) / ((P - S - D) * a)
 *
 * and the earliest context size at which switching repays itself over H turns is
 *   P* = (H * (S + D) * a + D + overhead) / (a * (H - 1)).
 *
 * A quality-aware recommendation also waits for a fraction of the context
 * window, because a handoff written at 15% of a 128k window saves tokens but
 * discards context the user may still need.
 *
 * @module dsh-context-handoff/economics
 */

/** Round a token count for display. */
export function formatTokens(value) {
  if (!Number.isFinite(value)) return '∞'
  const n = Math.max(0, Math.round(value))
  if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`
  return String(n)
}

/** Format a turn count with one decimal below 10. */
export function formatTurns(value) {
  if (!Number.isFinite(value)) return '∞'
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1)
}

/** Format a fraction as a whole percentage. */
export function formatPercent(value) {
  if (!Number.isFinite(value)) return 'n/a'
  return `${Math.round(value * 100)}%`
}

/**
 * Pick a digest budget for the current context.
 *
 * The digest scales with context but never exceeds `targetDigestTokens`; a
 * large window does not justify a 30k-token handoff that costs more per turn
 * than it saves.
 *
 * @param {object} input
 * @param {number} input.promptTokens - current prompt pressure.
 * @param {number} input.fixedPrefixTokens - system + tool schema tokens.
 * @param {number} [input.windowTokens] - model context window, when known.
 * @param {object} input.config - resolved plugin config.
 * @returns {number} digest budget in tokens.
 */
export function chooseDigestBudget({ promptTokens, fixedPrefixTokens, windowTokens, config }) {
  const scaled = Math.round(Math.max(0, promptTokens) * config.digestRatio)
  let budget = Math.max(config.minDigestTokens, scaled)
  budget = Math.min(budget, config.targetDigestTokens, config.maxDigestTokens)
  if (Number.isFinite(windowTokens) && windowTokens > 0) {
    budget = Math.min(budget, Math.max(config.minDigestTokens, Math.floor(windowTokens * 0.08)))
  }
  // A digest that consumes the whole message budget can never save anything.
  const messageBudget = Math.max(0, promptTokens - fixedPrefixTokens)
  if (messageBudget > 0) budget = Math.min(budget, Math.max(200, Math.floor(messageBudget * 0.6)))
  return Math.max(200, Math.round(budget))
}

/**
 * Compute the full comparison used by `/handoff plan`, `/handoff now`, and the
 * ledger.
 *
 * @param {object} input
 * @param {number} input.promptTokens - current prompt pressure.
 * @param {number} input.fixedPrefixTokens - system prompt + tool schema tokens.
 * @param {number} input.digestTokens - digest size in tokens.
 * @param {number} [input.windowTokens] - model context window.
 * @param {number} input.horizonTurns - turns to look ahead.
 * @param {number} input.cacheHitRatio - assumed cache hit share.
 * @param {number} input.cacheReadWeight - cache-read cost weight.
 * @param {number} input.switchOverheadTokens - re-orientation overhead.
 * @param {number} input.recommendAtRatio - quality threshold as window fraction.
 * @param {number} [input.recommendMaxTokens] - absolute cap for the quality threshold.
 * @param {number} [input.reserveTokens] - output/protocol headroom kept below the window.
 * @returns {Readonly<object>} plan.
 */
export function computePlan(input) {
  const promptTokens = Math.max(0, Number(input.promptTokens) || 0)
  const fixedPrefixTokens = Math.max(0, Number(input.fixedPrefixTokens) || 0)
  const digestTokens = Math.max(0, Number(input.digestTokens) || 0)
  const windowTokens = Number.isFinite(input.windowTokens) && input.windowTokens > 0 ? input.windowTokens : undefined
  const horizonTurns = Math.max(2, Math.round(Number(input.horizonTurns) || 8))
  const cacheHitRatio = clamp01(Number(input.cacheHitRatio) || 0)
  const cacheReadWeight = clamp01(Number(input.cacheReadWeight) || 0)
  const switchOverheadTokens = Math.max(0, Number(input.switchOverheadTokens) || 0)
  const recommendAtRatio = clamp01(Number(input.recommendAtRatio) || 0.55)
  const recommendMaxTokens =
    Number.isFinite(input.recommendMaxTokens) && input.recommendMaxTokens > 0 ? input.recommendMaxTokens : Infinity
  const reserveTokens = Math.max(0, Number(input.reserveTokens) || 8192)

  const cacheFactor = 1 - cacheHitRatio + cacheHitRatio * cacheReadWeight
  const perTurnCurrent = promptTokens * cacheFactor
  const perTurnNext = (fixedPrefixTokens + digestTokens) * cacheFactor
  const savingPerTurn = Math.max(0, perTurnCurrent - perTurnNext)
  const oneTimeCost = promptTokens * cacheFactor + digestTokens + switchOverheadTokens
  const breakEvenTurns = savingPerTurn > 0 ? oneTimeCost / savingPerTurn : Infinity

  const economicAt =
    horizonTurns > 1 && cacheFactor > 0
      ? (horizonTurns * (fixedPrefixTokens + digestTokens) * cacheFactor + digestTokens + switchOverheadTokens) /
        (cacheFactor * (horizonTurns - 1))
      : Infinity
  const usableLimit = windowTokens === undefined ? Infinity : Math.max(0, windowTokens - reserveTokens)
  const comfortAt =
    windowTokens === undefined
      ? Infinity
      : Math.min(windowTokens * recommendAtRatio, recommendMaxTokens, usableLimit)
  const recommendedAt =
    windowTokens === undefined ? economicAt : Math.min(Math.max(economicAt, comfortAt), usableLimit)
  const headroomTokens = windowTokens === undefined ? undefined : Math.max(0, windowTokens - promptTokens)
  const pressureRatio = windowTokens === undefined ? undefined : promptTokens / windowTokens
  const projectedSavings = savingPerTurn * horizonTurns - oneTimeCost
  const useful = savingPerTurn > 0
  const recommendedNow = Number.isFinite(recommendedAt) && promptTokens >= recommendedAt
  const efficientNow = Number.isFinite(economicAt) && promptTokens >= economicAt

  let verdict
  if (!useful) verdict = 'no-benefit'
  else if (recommendedNow) verdict = 'switch-now'
  else if (efficientNow) verdict = 'efficient-wait'
  else verdict = 'continue'

  return Object.freeze({
    promptTokens,
    fixedPrefixTokens,
    messageTokens: Math.max(0, promptTokens - fixedPrefixTokens),
    digestTokens,
    windowTokens,
    headroomTokens,
    pressureRatio,
    horizonTurns,
    cacheFactor,
    perTurnCurrent,
    perTurnNext,
    savingPerTurn,
    oneTimeCost,
    breakEvenTurns,
    economicAt,
    comfortAt,
    recommendMaxTokens,
    reserveTokens,
    usableLimit,
    recommendedAt,
    tokensToRecommended: Number.isFinite(recommendedAt) ? Math.max(0, recommendedAt - promptTokens) : undefined,
    projectedSavings,
    useful,
    recommendedNow,
    efficientNow,
    verdict,
  })
}

/**
 * Format the one-paragraph recommendation used by command output.
 * @param {ReturnType<typeof computePlan>} plan
 * @returns {string}
 */
export function describeVerdict(plan) {
  switch (plan.verdict) {
    case 'switch-now':
      return `Recommended now: a handoff repays itself in ${formatTurns(plan.breakEvenTurns)} turns, and the context is already at ${formatPercent(plan.pressureRatio)} of the window.`
    case 'efficient-wait':
      return `Switching already saves tokens (break-even ${formatTurns(plan.breakEvenTurns)} turns), but the recommendation point is ${formatTokens(plan.recommendedAt)} tokens (${formatTokens(plan.tokensToRecommended)} more).`
    case 'no-benefit':
      return 'No benefit yet: the digest plus the fixed prefix is not smaller than the current prompt, so a new session would re-read as much as this one.'
    default:
      if (!Number.isFinite(plan.economicAt) && !Number.isFinite(plan.recommendedAt)) {
        return 'Not enough model/context information to compare reliably; run /handoff now if you need a handoff anyway.'
      }
      return `Continue for now: switching is not cheaper until about ${formatTokens(plan.economicAt)} tokens, and the quality-oriented trigger is ${formatTokens(plan.recommendedAt)}.`
  }
}

/**
 * Compute the effective cache factor from config.
 * @param {{cacheHitRatio:number, cacheReadWeight:number}} config
 * @returns {number}
 */
export function cacheFactorOf(config) {
  return 1 - config.cacheHitRatio + config.cacheHitRatio * config.cacheReadWeight
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
