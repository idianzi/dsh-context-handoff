import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chooseDigestBudget,
  computePlan,
  describeVerdict,
  formatPercent,
  formatTokens,
  formatTurns,
} from '../lib/economics.js'
import { resolveConfig } from '../lib/config.js'

const base = {
  promptTokens: 100000,
  fixedPrefixTokens: 10000,
  digestTokens: 3000,
  windowTokens: 128000,
  horizonTurns: 8,
  cacheHitRatio: 0.5,
  cacheReadWeight: 0.1,
  switchOverheadTokens: 1500,
  recommendAtRatio: 0.6,
}

test('computePlan computes cache-adjusted saving and break-even', () => {
  const plan = computePlan(base)
  assert.equal(plan.cacheFactor, 0.55)
  assert.ok(Math.abs(plan.perTurnCurrent - 55000) < 1e-6)
  assert.ok(Math.abs(plan.perTurnNext - 7150) < 1e-6)
  assert.ok(Math.abs(plan.savingPerTurn - 47850) < 1e-6)
  assert.ok(Math.abs(plan.oneTimeCost - 59500) < 1e-9)
  assert.ok(Math.abs(plan.breakEvenTurns - 59500 / 47850) < 1e-9)
  assert.ok(Math.abs(plan.economicAt - 16025.974) < 0.01)
  assert.equal(plan.comfortAt, 76800)
  assert.equal(plan.recommendedAt, 76800)
  assert.equal(plan.verdict, 'switch-now')
  assert.ok(plan.projectedSavings > 0)
  assert.match(describeVerdict(plan), /Recommended now/)
})

test('computePlan reports no benefit when the digest is not smaller', () => {
  const plan = computePlan({ ...base, promptTokens: 5000, fixedPrefixTokens: 4000, digestTokens: 3000 })
  assert.equal(plan.useful, false)
  assert.equal(plan.savingPerTurn, 0)
  assert.equal(plan.breakEvenTurns, Infinity)
  assert.equal(plan.verdict, 'no-benefit')
  assert.match(describeVerdict(plan), /No benefit yet/)
})

test('computePlan distinguishes efficient-now from quality-now', () => {
  const plan = computePlan({ ...base, promptTokens: 30000, fixedPrefixTokens: 10000, digestTokens: 2000, windowTokens: 128000 })
  assert.equal(plan.verdict, 'efficient-wait')
  assert.ok(plan.promptTokens > plan.economicAt)
  assert.ok(plan.promptTokens < plan.recommendedAt)
  assert.match(describeVerdict(plan), /recommendation point/)
})

test('computePlan says continue below the economic point', () => {
  const plan = computePlan({ ...base, promptTokens: 8500, fixedPrefixTokens: 6000, digestTokens: 2000, windowTokens: 128000 })
  assert.equal(plan.verdict, 'continue')
  assert.ok(plan.promptTokens < plan.economicAt)
})

test('chooseDigestBudget scales then caps at the target', () => {
  const config = resolveConfig({})
  const large = chooseDigestBudget({ promptTokens: 120000, fixedPrefixTokens: 12000, windowTokens: 128000, config })
  assert.equal(large, 3000)
  const small = chooseDigestBudget({ promptTokens: 20000, fixedPrefixTokens: 8000, windowTokens: 32000, config })
  assert.equal(small, 700)
  const tinyWindow = chooseDigestBudget({ promptTokens: 32000, fixedPrefixTokens: 2000, windowTokens: 32000, config })
  assert.ok(tinyWindow <= 2560)
})

test('format helpers are stable', () => {
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1000), '1.0k')
  assert.equal(formatTokens(128000), '128k')
  assert.equal(formatTokens(1250000), '1.3M')
  assert.equal(formatTokens(Infinity), '∞')
  assert.equal(formatTurns(Infinity), '∞')
  assert.equal(formatPercent(0.943), '94%')
})

test('recommendation point is capped for very large windows', () => {
  const plan = computePlan({
    ...base,
    promptTokens: 400000,
    windowTokens: 1000000,
    recommendAtRatio: 0.55,
    recommendMaxTokens: 96000,
    reserveTokens: 8192,
  })
  assert.equal(plan.comfortAt, 96000)
  assert.equal(plan.recommendedAt, 96000)
  assert.equal(plan.verdict, 'switch-now')
})

test('recommendation point stays below the window reserve', () => {
  const plan = computePlan({
    ...base,
    promptTokens: 30000,
    fixedPrefixTokens: 4000,
    digestTokens: 1000,
    windowTokens: 32000,
    recommendAtRatio: 1,
    recommendMaxTokens: 1000000,
    reserveTokens: 8192,
  })
  assert.equal(plan.usableLimit, 23808)
  assert.equal(plan.recommendedAt, 23808)
})

test('unknown window falls back to the economic point', () => {
  const plan = computePlan({ ...base, windowTokens: undefined })
  assert.equal(plan.comfortAt, Infinity)
  assert.equal(plan.recommendedAt, plan.economicAt)
  assert.equal(plan.verdict, 'switch-now')
})

test('default absolute cap applies to a one-million-token window', () => {
  const plan = computePlan({
    ...base,
    promptTokens: 480000,
    windowTokens: 1048576,
    recommendAtRatio: 0.55,
    recommendMaxTokens: 256000,
    reserveTokens: 8192,
  })
  assert.equal(plan.comfortAt, 256000)
  assert.equal(plan.recommendedAt, 256000)
  assert.equal(plan.verdict, 'switch-now')
})
