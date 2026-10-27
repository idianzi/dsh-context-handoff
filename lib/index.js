/**
 * dsh-context-handoff — a token-aware session handoff plugin for DSH.
 *
 * Registers `/handoff` and, when enabled, watches idle sessions for the point
 * where writing a compact handoff becomes cheaper than carrying the full
 * conversation forward.
 *
 * @module dsh-context-handoff
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { AutoStateStore } from './auto-state.js'
import { Config, resolveConfig } from './config.js'
import {
  buildFallbackBody,
  enforceFileBudget,
  extractTitle,
  fileReference,
  priceHandoff,
  priceMessage,
  redactSecrets,
  renderHandoffFile,
  resolveLanguage,
  sanitizeModelMarkdown,
} from './digest.js'
import { chooseDigestBudget, computePlan, formatTokens } from './economics.js'
import {
  appendLedger,
  displayPath,
  handoffFileName,
  latestHandoff,
  listHandoffs,
  pruneHandoffs,
  readLedger,
  resolveOutputDir,
  writeHandoff,
} from './files.js'
import {
  formatGeneratedReport,
  formatListReport,
  formatPlanReport,
  formatStatsReport,
  formatStatusReport,
  HELP_TEXT,
} from './format.js'
import { sendError, sendJson, mutationAllowed, readJsonBody } from './http.js'
import { buildInstruction, buildSummaryRequest, resolveSummaryTarget, streamSummary } from './summarize.js'

/** Thrown when a handoff cannot start because the agent is already working. */
export class HandoffBusyError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'HandoffBusyError'
    this.code = 'HANDOFF_BUSY'
  }
}

/**
 * Token-aware handoff plugin.
 */
export default class ContextHandoff {
  static inject = ['agents', 'llm', 'sessions', 'tokenMeter']

  static Config = Config

  /**
   * @param {object} ctx - Cordis context.
   * @param {object} [config] - validated entry config.
   */
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.config = resolveConfig(config)
    /** @type {Map<string, Promise<object>>} */
    this.active = new Map()
    /** @type {Map<string, {tokens: number, at: number, completed?: boolean}>} */
    this.lastAuto = new Map()
    /** @type {Map<string, {newSessionId: string, file: string, at: number}>} */
    this.lastAutoBySource = new Map()
    /** @type {Map<string, object>} */
    this.createdAgents = new Map()
    /** @type {Map<string, number | undefined>} */
    this.windowCache = new Map()
    this.autoState = new AutoStateStore(this.config)
    this.autoTimer = undefined
    /** @type {Map<string, {count: number, lastAt: number, before: number, after: number, saved: number, failedAt?: number}>} */
    this.compactions = new Map()
    /** @type {object | undefined} */
    this.compaction = undefined
    /** How the compaction service was found; surfaced in the panel for diagnosis. */
    this.compactionSource = 'none'
    /** @type {Set<string>} */
    this.compacting = new Set()

    const plugin = this
    const registerCommand = (commandCtx) => {
      commandCtx.effect(function* registerHandoffCommand() {
        yield commandCtx.commands.register({
          definitionId: 'dsh-context-handoff',
          name: 'handoff',
          description: 'Summarize this session into a handoff file and compare its token cost',
          input: { hint: '[plan|status|list|stats|help] [turns|tokens]' },
          handler: (invocation) => plugin.handleCommand(invocation),
        })
      }, 'context-handoff command')
      plugin.ctx.logger?.info?.('context-handoff: registered /handoff command')
    }
    if (typeof ctx.inject === 'function') {
      // Optional: headless/ACP profiles may not mount the command registry, but
      // auto mode still works there because it is a host-side listener.
      ctx.inject(['commands'], (commandCtx) => registerCommand(commandCtx))
      // Condensation is provided by the composition (dsh-compaction-basic).
      // Without it the plugin still handoffs, it just cannot condense first.
      ctx.inject(['compaction'], (compactionCtx) => {
        if (compactionCtx.compaction !== undefined && plugin.compaction === undefined) {
          plugin.compaction = compactionCtx.compaction
          plugin.compactionSource = 'inject'
          plugin.ctx.logger?.info?.('context-handoff: compaction service injected')
        }
      })
    } else if (ctx.commands !== undefined) {
      registerCommand(ctx)
    }

    this.installAuto()
    this.installHttpRoutes()
  }

  /**
   * Dispatch `/handoff` input.
   * @param {object} invocation - command invocation from dsh-commands.
   * @returns {Promise<{kind: 'success'|'error', text: string}>}
   */
  async handleCommand(invocation) {
    const raw = String(invocation.rawInput ?? '').trim()
    const [subcommand = 'now', ...rest] = raw.length === 0 ? [] : raw.split(/\s+/u)
    try {
      switch (subcommand) {
        case 'now':
          return await this.commandNow(invocation, rest)
        case 'plan':
          return await this.commandPlan(invocation, rest)
        case 'status':
          return await this.commandStatus(invocation, rest)
        case 'list':
          return await this.commandList(invocation, rest)
        case 'stats':
          return await this.commandStats(invocation, rest)
        case 'auto':
          return await this.commandAuto(invocation, rest)
        case 'help':
          return { kind: 'success', text: HELP_TEXT }
        default:
          return { kind: 'error', text: `Unknown /handoff subcommand: ${subcommand}\n\n${HELP_TEXT}` }
      }
    } catch (error) {
      if (invocation.signal?.aborted || error?.code === 'ABORTED') {
        return { kind: 'error', text: 'Handoff cancelled.' }
      }
      if (error instanceof HandoffBusyError) return { kind: 'error', text: error.message }
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'error', text: `Handoff failed: ${message}` }
    }
  }

  async commandNow(invocation, rest) {
    let budgetOverride
    if (rest.length > 1) return { kind: 'error', text: 'Usage: /handoff now [digest-tokens]' }
    if (rest.length === 1) {
      budgetOverride = Number(rest[0])
      if (!Number.isInteger(budgetOverride) || budgetOverride < 600) {
        return { kind: 'error', text: 'The digest budget must be an integer of at least 600 tokens.' }
      }
      budgetOverride = Math.min(budgetOverride, this.config.maxDigestTokens)
    }
    const result = await this.generate(invocation.agent, {
      trigger: 'command',
      signal: invocation.signal,
      budgetOverride,
    })
    return { kind: 'success', text: result.text }
  }

  async commandPlan(invocation, rest) {
    if (rest.length > 1) return { kind: 'error', text: 'Usage: /handoff plan [turns]' }
    let horizon = this.config.horizonTurns
    if (rest.length === 1) {
      horizon = Number(rest[0])
      if (!Number.isInteger(horizon) || horizon < 2 || horizon > 1000) {
        return { kind: 'error', text: 'The horizon must be an integer between 2 and 1000 turns.' }
      }
    }
    const snapshot = await this.inspect(invocation.agent, { signal: invocation.signal, horizon })
    const text = formatPlanReport({
      plan: snapshot.plan,
      config: this.config,
      digestBudget: snapshot.digestBudget,
      extra: { sessionTokens: snapshot.cumulativeTokens, turns: snapshot.turns, perTurn: snapshot.perTurnTokens },
    })
    return { kind: 'success', text }
  }

  async commandStatus(invocation, rest) {
    if (rest.length > 0) return { kind: 'error', text: 'Usage: /handoff status' }
    const snapshot = await this.inspect(invocation.agent, { signal: invocation.signal, horizon: this.config.horizonTurns })
    const latest = await latestHandoff(snapshot.outputDir)
    const text = formatStatusReport({
      cwd: snapshot.cwd,
      latest,
      plan: snapshot.plan,
      digestBudget: snapshot.digestBudget,
      config: this.config,
    })
    return { kind: 'success', text }
  }

  async commandList(invocation, rest) {
    if (rest.length > 0) return { kind: 'error', text: 'Usage: /handoff list' }
    const snapshot = await this.inspect(invocation.agent, { signal: invocation.signal, horizon: this.config.horizonTurns })
    const files = await listHandoffs(snapshot.outputDir)
    return { kind: 'success', text: formatListReport(files, snapshot.cwd) }
  }

  async commandStats(invocation, rest) {
    if (rest.length > 0) return { kind: 'error', text: 'Usage: /handoff stats' }
    const snapshot = await this.inspect(invocation.agent, { signal: invocation.signal, horizon: this.config.horizonTurns })
    const records = this.config.ledger ? await readLedger(snapshot.outputDir) : []
    const files = await listHandoffs(snapshot.outputDir)
    const text = formatStatsReport({
      records,
      fileCount: files.length,
      usage: snapshot.sessionUsage,
    })
    return { kind: 'success', text }
  }

  async commandAuto(invocation, rest) {
    if (rest.length > 1) return { kind: 'error', text: 'Usage: /handoff auto [on|off]' }
    const snapshot = await this.inspect(invocation.agent, { signal: invocation.signal, horizon: this.config.horizonTurns })
    if (rest.length === 1) {
      const action = rest[0].toLowerCase()
      if (action !== 'on' && action !== 'off') return { kind: 'error', text: 'Usage: /handoff auto [on|off]' }
      await this.autoState.write(snapshot.cwd, action === 'on')
      if (action === 'on') setTimeout(() => void this.maybeAuto(invocation.agent), 100)
    }
    const setting = await this.autoState.read(snapshot.cwd)
    const threshold = Number.isFinite(snapshot.plan.recommendedAt)
      ? `${formatTokens(snapshot.plan.recommendedAt)} tokens`
      : 'unknown (no model window)'
    return {
      kind: 'success',
      text: [
        `Auto handoff for ${snapshot.cwd}: ${setting.auto ? 'ON' : 'OFF'}${setting.explicit ? '' : ' (config default)'}`,
        `Trigger: ${threshold} · current ${formatTokens(snapshot.promptTokens)} · ${this.config.autoNewSession ? 'creates a new session' : 'writes a file only'}`,
        'The sidebar switch writes the same per-workspace setting.',
      ].join('\n'),
    }
  }

  /**
   * Snapshot the session and compute the comparison without writing anything.
   * @param {object} agent
   * @param {{signal?: AbortSignal, horizon?: number}} [options]
   * @returns {Promise<object>}
   */
  async inspect(agent, options = {}) {
    const session = agent?.session
    if (session === undefined) throw new Error('this command needs a live agent session')
    const cwd = typeof session.header?.cwd === 'string' && session.header.cwd.length > 0 ? session.header.cwd : process.cwd()
    const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
    const meter = this.ctx.tokenMeter
    let measure
    try {
      measure = meter.measure(session)
    } catch (error) {
      const fallback = messages.reduce((total, message) => total + priceMessage(meter, message), 0)
      measure = { totalTokens: fallback, surfaceTokens: fallback, nodes: [] }
    }
    const promptTokens = Math.max(0, Number(measure.totalTokens) || 0)
    const surfaceTokens = Math.max(0, Number(measure.surfaceTokens) || 0)
    const systemTokens = messages
      .filter((message) => message?.role === 'system')
      .reduce((total, message) => total + priceMessage(meter, message), 0)
    const toolsTokens = Math.max(0, promptTokens - surfaceTokens)
    const breakdown = this.readProjection(session, 'contextBreakdown')
    const breakdownFixed =
      breakdown !== undefined && Number.isFinite(breakdown.systemTokens) && Number.isFinite(breakdown.toolsTokens)
        ? Number(breakdown.systemTokens) + Number(breakdown.toolsTokens)
        : undefined
    const fixedPrefixTokens = Math.min(
      promptTokens,
      Math.max(0, breakdownFixed ?? systemTokens + toolsTokens),
    )
    const outputDir = resolveOutputDir(cwd, this.config.outputDir)

    let target
    let targetError
    try {
      target = await resolveSummaryTarget({
        ctx: this.ctx,
        agent,
        config: this.config,
        signal: options.signal,
        cache: this.windowCache,
      })
    } catch (error) {
      targetError = error instanceof Error ? error.message : String(error)
    }
    const windowTokens = target?.windowTokens
    const digestBudget = chooseDigestBudget({
      promptTokens,
      fixedPrefixTokens,
      windowTokens,
      config: this.config,
    })
    const plan = computePlan({
      promptTokens,
      fixedPrefixTokens,
      digestTokens: digestBudget,
      windowTokens,
      horizonTurns: options.horizon ?? this.config.horizonTurns,
      cacheHitRatio: this.config.cacheHitRatio,
      cacheReadWeight: this.config.cacheReadWeight,
      switchOverheadTokens: this.config.switchOverheadTokens,
      recommendAtRatio: this.config.recommendAtRatio,
      recommendMaxTokens: this.config.recommendMaxTokens,
      reserveTokens: this.config.maxOutputTokens > 0 ? this.config.maxOutputTokens + 4096 : 8192,
    })
    const sessionUsage = this.readProjection(session, 'tokenUsage')
    const autoSetting = await this.autoState.read(cwd)
    const turns = messages.filter((message) => message?.role === 'user').length
    const cumulativeTokens =
      sessionUsage === undefined
        ? undefined
        : (Number(sessionUsage.uncachedInputTokens) || 0) +
          (Number(sessionUsage.cacheReadTokens) || 0) +
          (Number(sessionUsage.cacheWriteTokens) || 0) +
          (Number(sessionUsage.outputTokens) || 0)
    const perTurnTokens = cumulativeTokens !== undefined && turns > 0 ? cumulativeTokens / turns : undefined
    options.signal?.throwIfAborted()

    return {
      session,
      cwd,
      messages,
      meter,
      measure,
      promptTokens,
      surfaceTokens,
      fixedPrefixTokens,
      messagesTokens: Math.max(0, promptTokens - fixedPrefixTokens),
      digestBudget,
      plan,
      windowTokens,
      target,
      targetError,
      outputDir,
      auto: autoSetting.auto,
      autoExplicit: autoSetting.explicit,
      sessionUsage,
      cumulativeTokens,
      turns,
      perTurnTokens,
      title: extractTitle(messages, session.id),
      language: resolveLanguage(this.config.language, messages),
    }
  }

  /** Read one host projection without making sessionProjections a hard dependency. */
  readProjection(session, key) {
    try {
      const projections = this.ctx.get?.('sessionProjections') ?? this.ctx.sessionProjections
      const state = projections?.stateOf?.(session, key)
      return state !== null && typeof state === 'object' ? state : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Write a handoff for one agent. Serializes per session and runs as agent
   * maintenance when the loop exposes it, so a queued prompt cannot interleave.
   * @param {object} agent
   * @param {{trigger?: string, signal?: AbortSignal, budgetOverride?: number, newSession?: boolean}} [options]
   * @returns {Promise<object>}
   */
  async generate(agent, options = {}) {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string') throw new Error('this command needs a live agent session')
    if (this.active.has(sessionId)) {
      throw new HandoffBusyError('A handoff is already being generated for this session; wait for it to finish.')
    }
    const operation = this.runWithMaintenance(agent, options.signal, (signal) => this.generateInner(agent, { ...options, signal }))
    this.active.set(sessionId, operation)
    try {
      return await operation
    } finally {
      this.active.delete(sessionId)
    }
  }

  async runWithMaintenance(agent, signal, fn) {
    if (typeof agent.runMaintenance !== 'function') return fn(signal)
    let started = false
    try {
      return await agent.runMaintenance(async (maintenanceSignal) => {
        started = true
        return fn(combineSignals(maintenanceSignal, signal))
      })
    } catch (error) {
      if (!started) {
        throw new HandoffBusyError('The handoff could not start because the agent is not idle. Wait for the current turn to finish and retry.', {
          cause: error,
        })
      }
      throw error
    }
  }

  async generateInner(agent, options) {
    const { signal, trigger = 'command' } = options
    signal?.throwIfAborted()
    const snapshot = await this.inspect(agent, { signal, horizon: this.config.horizonTurns })
    signal?.throwIfAborted()
    const budget = clamp(
      options.budgetOverride ?? snapshot.digestBudget,
      600,
      Math.max(600, this.config.maxDigestTokens),
    )
    if (!hasSummarizableContent(snapshot.messages)) {
      throw new Error('nothing to hand off yet; start a conversation first')
    }
    const language = snapshot.language
    const title = snapshot.title
    const createdAt = new Date()
    const dir = snapshot.outputDir
    const filename = handoffFileName(snapshot.session.id, createdAt)
    const absolutePath = path.join(dir, filename)
    const relativePath = displayPath(snapshot.cwd, absolutePath)
    const maxOutputTokens =
      this.config.maxOutputTokens > 0
        ? this.config.maxOutputTokens
        : clamp(Math.ceil(Math.max(300, budget - 220) * 1.6), 512, 8192)

    let body
    let generator = 'llm'
    let fallbackReason
    let summary
    let summaryMode
    let omittedMessages = 0
    if (snapshot.target === undefined) {
      if (!this.config.fallbackDigest) throw new Error(snapshot.targetError ?? 'no summarization model is available')
      generator = 'fallback'
      fallbackReason = snapshot.targetError ?? 'no summarization model is available'
    } else {
      const instruction = buildInstruction({
        budgetTokens: Math.max(300, budget - 220),
        language,
        title,
        promptTokens: snapshot.promptTokens,
      })
      const toolHistory = typeof snapshot.session.toolHistory === 'function' ? snapshot.session.toolHistory() : undefined
      const tools = snapshot.session.requestHeader?.()?.tools
      const request = buildSummaryRequest({
        messages: snapshot.messages,
        target: snapshot.target,
        config: this.config,
        meter: snapshot.meter,
        instruction,
        maxOutputTokens,
        toolHistory,
        tools,
      })
      summaryMode = request.mode
      omittedMessages = request.omittedMessages
      try {
        summary = await streamSummary({
          ctx: this.ctx,
          agent,
          config: this.config,
          target: snapshot.target,
          request,
          signal,
        })
        body = sanitizeModelMarkdown(summary.text)
        if (body.trim().length === 0) throw new Error('the summarization model returned no text')
      } catch (error) {
        signal?.throwIfAborted()
        if (error?.code === 'ABORTED') throw error
        if (!this.config.fallbackDigest) throw error
        generator = 'fallback'
        summary = undefined
        const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim()
        fallbackReason = reason.length > 300 ? `${reason.slice(0, 299)}…` : reason
      }
    }

    if (body === undefined) {
      body = buildFallbackBody({
        title,
        messages: snapshot.messages,
        language,
        stats: { promptTokens: snapshot.promptTokens, created: createdAt.toISOString() },
        includeToolDetails: this.config.includeToolDetails,
      })
    }
    if (this.config.redactSecrets) body = redactSecrets(body)

    const baseMeta = {
      dsh_handoff: 1,
      session: snapshot.session.id,
      created: createdAt.toISOString(),
      cwd: snapshot.cwd,
      provider: snapshot.target?.provider ?? '',
      model: snapshot.target?.model ?? '',
      source_tokens: snapshot.promptTokens,
      ...(snapshot.windowTokens === undefined ? {} : { window_tokens: snapshot.windowTokens }),
      fixed_tokens: snapshot.fixedPrefixTokens,
      budget_tokens: budget,
      horizon_turns: this.config.horizonTurns,
      generator,
      summary_mode: generator === 'llm' ? summaryMode ?? 'unknown' : 'fallback',
      language,
      truncated: false,
    }

    let meta = baseMeta
    let finalBody = body
    let content = ''
    let digestTokens = 0
    let truncated = false
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const enforced = enforceFileBudget({
        meta,
        body: finalBody,
        cwd: snapshot.cwd,
        relativePath,
        title,
        budgetTokens: budget,
        meter: snapshot.meter,
        language,
      })
      content = enforced.text
      finalBody = enforced.body
      digestTokens = enforced.tokens
      truncated = truncated || enforced.truncated
      const actualPlan = this.planFor(snapshot, enforced.tokens)
      const nextMeta = {
        ...baseMeta,
        digest_tokens: Math.round(enforced.tokens),
        saving_per_turn: Math.round(actualPlan.savingPerTurn),
        ...(Number.isFinite(actualPlan.breakEvenTurns)
          ? { break_even_turns: Math.round(actualPlan.breakEvenTurns * 100) / 100 }
          : {}),
        projected_saved_tokens: Math.round(actualPlan.projectedSavings),
        truncated,
      }
      const settled = meta.digest_tokens === nextMeta.digest_tokens && meta.truncated === nextMeta.truncated
      meta = nextMeta
      if (settled) break
    }
    content = renderHandoffFile({
      meta,
      body: finalBody,
      cwd: snapshot.cwd,
      relativePath,
      title,
      language,
    })
    digestTokens = priceHandoff(snapshot.meter, content)
    // Converge the reported digest size with the final frontmatter digits.
    for (let attempt = 0; attempt < 2 && meta.digest_tokens !== Math.round(digestTokens); attempt += 1) {
      const settledPlan = this.planFor(snapshot, digestTokens)
      meta = {
        ...meta,
        digest_tokens: Math.round(digestTokens),
        saving_per_turn: Math.round(settledPlan.savingPerTurn),
        ...(Number.isFinite(settledPlan.breakEvenTurns)
          ? { break_even_turns: Math.round(settledPlan.breakEvenTurns * 100) / 100 }
          : {}),
        projected_saved_tokens: Math.round(settledPlan.projectedSavings),
      }
      content = renderHandoffFile({
        meta,
        body: finalBody,
        cwd: snapshot.cwd,
        relativePath,
        title,
        language,
      })
      digestTokens = priceHandoff(snapshot.meter, content)
    }

    const actualPlan = this.planFor(snapshot, digestTokens)
    await writeHandoff(dir, filename, content)
    const pruned = await pruneHandoffs(dir, this.config.keepFiles)

    let newSession
    let sessionError
    if (options.newSession) {
      try {
        newSession = await this.startNewSession(agent, snapshot, { relativePath, language })
      } catch (error) {
        sessionError = error instanceof Error ? error.message : String(error)
        this.ctx.logger?.warn?.(`context-handoff: could not create a new session: ${sessionError}`)
      }
    }

    const effectiveSummaryTokens =
      summary?.effectiveTokens !== undefined ? summary.effectiveTokens : generator === 'llm' ? Math.round(actualPlan.oneTimeCost) : 0
    if (this.config.ledger) {
      await appendLedger(dir, {
        v: 1,
        at: createdAt.toISOString(),
        session: snapshot.session.id,
        file: relativePath,
        trigger,
        generator,
        summary_mode: generator === 'llm' ? summaryMode ?? 'unknown' : 'fallback',
        omitted_messages: omittedMessages,
        ...(fallbackReason === undefined ? {} : { fallback_reason: fallbackReason }),
        language,
        provider: snapshot.target?.provider ?? '',
        model: snapshot.target?.model ?? '',
        source_tokens: snapshot.promptTokens,
        fixed_tokens: snapshot.fixedPrefixTokens,
        digest_tokens: Math.round(digestTokens),
        budget_tokens: budget,
        window_tokens: snapshot.windowTokens ?? 0,
        summary_tokens: Math.round(effectiveSummaryTokens),
        summary_input_tokens: summary?.usage === undefined
          ? 0
          : (Number(summary.usage.inputTokens) || 0) +
            (Number(summary.usage.cacheReadTokens) || 0) +
            (Number(summary.usage.cacheWriteTokens) || 0),
        summary_output_tokens: summary?.usage === undefined ? 0 : Number(summary.usage.outputTokens) || 0,
        saving_per_turn: Math.round(actualPlan.savingPerTurn),
        break_even_turns: Number.isFinite(actualPlan.breakEvenTurns)
          ? Math.round(actualPlan.breakEvenTurns * 100) / 100
          : 0,
        horizon_turns: actualPlan.horizonTurns,
        projected_saved_tokens: Math.round(actualPlan.projectedSavings),
        truncated,
      })
    }

    this.ctx.logger?.info?.(
      `context-handoff: wrote ${relativePath} (${formatTokens(digestTokens)} tokens, generator ${generator}${truncated ? ', trimmed' : ''}${pruned.length > 0 ? `, pruned ${pruned.length}` : ''})`,
    )

    const text = formatGeneratedReport({
      relativePath,
      cwd: snapshot.cwd,
      plan: actualPlan,
      digestTokens,
      budgetTokens: budget,
      generator,
      truncated,
      fallbackReason,
      language,
      summaryMode,
      omittedMessages,
      newSessionId: newSession?.sessionId,
      sessionError,
    })
    return {
      text,
      path: absolutePath,
      relativePath,
      digestTokens,
      plan: actualPlan,
      generator,
      truncated,
      pruned,
      ...(newSession === undefined ? {} : { newSessionId: newSession.sessionId }),
      ...(sessionError === undefined ? {} : { sessionError }),
    }
  }

  /**
   * Create a fresh root agent in the same workspace and queue the resume prompt.
   * The handoff file is already on disk, so the new session can read it on its
   * first turn. Failures are reported to the caller; the file remains valid.
   *
   * @param {object} sourceAgent
   * @param {object} snapshot
   * @param {{relativePath: string, language: 'en'|'zh'}} input
   * @returns {Promise<{sessionId: string}>}
   */
  async startNewSession(sourceAgent, snapshot, { relativePath, language }) {
    const route = snapshot.session.requestHeader?.()?.config
    const provider = snapshot.target?.provider ?? route?.provider ?? sourceAgent?.options?.provider
    const model = snapshot.target?.model ?? route?.model ?? sourceAgent?.options?.model
    const agentOptions = {
      ...(typeof provider === 'string' && provider.length > 0 ? { provider } : {}),
      ...(typeof model === 'string' && model.length > 0 ? { model } : {}),
      ...(typeof route?.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}),
      ...(typeof route?.maxTokens === 'number' && route.maxTokens > 0 ? { maxTokens: route.maxTokens } : {}),
    }
    const sessionId = randomUUID()
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: snapshot.cwd },
      agentOptions,
    })
    const heading = language === 'zh' ? '下一步' : 'Next steps'
    const prompt = language === 'zh'
      ? `Read ${fileReference(relativePath)} and continue from the "${heading}" section. 先读文件，不要复述摘要，直接从第一个下一步动作开始。`
      : `Read ${fileReference(relativePath)} and continue from the "${heading}" section. Do not restate the handoff; start with the first next action.`
    try {
      await handle.agent.followup({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      })
    } catch (error) {
      await handle.dispose().catch(() => {})
      throw error
    }
    this.createdAgents.set(sessionId, handle)
    return { sessionId }
  }

  planFor(snapshot, digestTokens) {
    return computePlan({
      promptTokens: snapshot.promptTokens,
      fixedPrefixTokens: snapshot.fixedPrefixTokens,
      digestTokens,
      windowTokens: snapshot.windowTokens,
      horizonTurns: this.config.horizonTurns,
      cacheHitRatio: this.config.cacheHitRatio,
      cacheReadWeight: this.config.cacheReadWeight,
      switchOverheadTokens: this.config.switchOverheadTokens,
      recommendAtRatio: this.config.recommendAtRatio,
      recommendMaxTokens: this.config.recommendMaxTokens,
      reserveTokens: this.config.maxOutputTokens > 0 ? this.config.maxOutputTokens + 4096 : 8192,
    })
  }

  /** Register the sidebar bridge routes when the Web host provides webServer. */
  installHttpRoutes() {
    if (typeof this.ctx.inject !== 'function') return
    const plugin = this
    this.ctx.inject(['webServer'], (hostCtx) => {
      const disposers = []
      const register = (route) => {
        disposers.push(hostCtx.webServer.register(route))
      }
      register({
        kind: 'exact',
        path: '/context-handoff/api/state',
        handler: (request, response) => {
          void plugin.handleStateRoute(request, response)
        },
      })
      register({
        kind: 'exact',
        path: '/context-handoff/api/auto',
        handler: (request, response) => {
          void plugin.handleAutoRoute(request, response)
        },
      })
      register({
        kind: 'exact',
        path: '/context-handoff/api/run',
        handler: (request, response) => {
          void plugin.handleRunRoute(request, response)
        },
      })
      register({
        kind: 'exact',
        path: '/context-handoff/api/ack',
        handler: (request, response) => {
          void plugin.handleAckRoute(request, response)
        },
      })
      hostCtx.effect(function* removeHandoffRoutes() {
        yield () => {
          for (const dispose of disposers.reverse()) dispose()
        }
      }, 'context-handoff routes')
    })
  }

  /** GET /context-handoff/api/state?session=<id> */
  async handleStateRoute(request, response) {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { ok: false, error: 'GET only' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const state = await this.stateForSession(url.searchParams.get('session'))
      sendJson(response, 200, state)
    } catch (error) {
      sendError(response, error)
    }
  }

  /** POST /context-handoff/api/auto { sessionId, enabled } */
  async handleAutoRoute(request, response) {
    try {
      if (!mutationAllowed(request)) {
        sendJson(response, 403, { ok: false, error: 'request refused' })
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'POST only' })
        return
      }
      const body = await readJsonBody(request)
      if (typeof body?.sessionId !== 'string' || typeof body?.enabled !== 'boolean') {
        sendJson(response, 400, { ok: false, error: 'sessionId and enabled are required' })
        return
      }
      const session = this.ctx.sessions.get(body.sessionId)
      if (session === undefined) {
        sendJson(response, 404, { ok: false, error: 'session not found' })
        return
      }
      const cwd = this.sessionCwd(session)
      await this.autoState.write(cwd, body.enabled)
      const state = await this.stateForSession(body.sessionId)
      sendJson(response, 200, state)
      if (body.enabled) {
        const agent = this.ctx.agents.get(body.sessionId)
        if (agent !== undefined) setTimeout(() => void this.maybeAuto(agent), 150)
      }
    } catch (error) {
      sendError(response, error)
    }
  }

  /** POST /context-handoff/api/run { sessionId, newSession } */
  async handleRunRoute(request, response) {
    try {
      if (!mutationAllowed(request)) {
        sendJson(response, 403, { ok: false, error: 'request refused' })
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'POST only' })
        return
      }
      const body = await readJsonBody(request)
      if (typeof body?.sessionId !== 'string') {
        sendJson(response, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      const agent = this.ctx.agents.get(body.sessionId)
      if (agent === undefined) {
        sendJson(response, 409, { ok: false, error: 'session is not live' })
        return
      }
      const result = await this.generate(agent, {
        trigger: 'panel',
        newSession: body.newSession === true,
      })
      sendJson(response, 200, { ok: true, result })
    } catch (error) {
      if (error instanceof HandoffBusyError) {
        sendJson(response, 409, { ok: false, error: error.message })
        return
      }
      sendError(response, error)
    }
  }

  /** POST /context-handoff/api/ack { sessionId, newSessionId } */
  async handleAckRoute(request, response) {
    try {
      if (!mutationAllowed(request)) {
        sendJson(response, 403, { ok: false, error: 'request refused' })
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'POST only' })
        return
      }
      const body = await readJsonBody(request)
      const entry = typeof body?.sessionId === 'string' ? this.lastAutoBySource.get(body.sessionId) : undefined
      if (entry !== undefined && (body.newSessionId === undefined || entry.newSessionId === body.newSessionId)) {
        this.lastAutoBySource.delete(body.sessionId)
      }
      sendJson(response, 200, { ok: true })
    } catch (error) {
      sendError(response, error)
    }
  }

  /** Build the sidebar payload for one live session. */
  async stateForSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return { ok: false, error: 'sessionId is required' }
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined) return { ok: false, error: 'session not found' }
    const cwd = this.sessionCwd(session)
    const agent = this.ctx.agents.get(sessionId)
    const setting = await this.autoState.read(cwd)
    if (agent === undefined) {
      return { ok: false, error: 'session is not live', sessionId, cwd, auto: setting.auto, autoExplicit: setting.explicit }
    }
    const snapshot = await this.inspect(agent, { horizon: this.config.horizonTurns })
    const latest = await latestHandoff(snapshot.outputDir)
    const lastAuto = this.lastAutoBySource.get(sessionId)
    return {
      ok: true,
      sessionId,
      cwd,
      auto: setting.auto,
      autoExplicit: setting.explicit,
      autoNewSession: this.config.autoNewSession,
      model: snapshot.target === undefined ? '' : `${snapshot.target.provider}/${snapshot.target.model}`,
      promptTokens: snapshot.promptTokens,
      windowTokens: snapshot.windowTokens ?? 0,
      recommendedAt: Number.isFinite(snapshot.plan.recommendedAt) ? Math.round(snapshot.plan.recommendedAt) : 0,
      economicAt: Number.isFinite(snapshot.plan.economicAt) ? Math.round(snapshot.plan.economicAt) : 0,
      digestBudget: snapshot.digestBudget,
      savingPerTurn: Math.round(snapshot.plan.savingPerTurn),
      breakEvenTurns: Number.isFinite(snapshot.plan.breakEvenTurns)
        ? Math.round(snapshot.plan.breakEvenTurns * 100) / 100
        : 0,
      running: this.active.has(sessionId),
      compaction: (() => {
        const record = this.compactions.get(sessionId)
        return {
          available: this.compactionService(agent) !== undefined,
          source: this.compactionSource,
          probe: {
            agentCompaction: (() => {
              try {
                return typeof agent?.ctx?.compaction
              } catch {
                return 'threw'
              }
            })(),
            rootCompaction: typeof this.ctx.compaction,
          },
          count: record?.count ?? 0,
          budget: this.config.maxCompactionsPerSession,
          before: record?.before ?? 0,
          after: record?.after ?? 0,
          saved: record?.saved ?? 0,
          at: record?.lastAt ?? 0,
        }
      })(),
      latest:
        latest === undefined
          ? null
          : {
              file: displayPath(cwd, latest.path),
              at: latest.mtimeMs,
              digestTokens: Number(latest.meta.digest_tokens) || 0,
              sourceTokens: Number(latest.meta.source_tokens) || 0,
            },
      lastAuto: lastAuto ?? null,
    }
  }

  sessionCwd(session) {
    return typeof session?.header?.cwd === 'string' && session.header.cwd.length > 0 ? session.header.cwd : process.cwd()
  }

  /** Install the idle-session auto writer. */
  installAuto() {
    const plugin = this
    this.ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || agent === undefined) return
      if (plugin.autoTimer !== undefined) clearTimeout(plugin.autoTimer)
      plugin.autoTimer = setTimeout(() => {
        plugin.autoTimer = undefined
        void plugin.maybeAuto(agent)
      }, 300)
      plugin.autoTimer.unref?.()
    })
    this.ctx.effect(function* clearAutoTimer() {
      yield () => {
        if (plugin.autoTimer !== undefined) clearTimeout(plugin.autoTimer)
      }
    }, 'context-handoff auto timer')
  }

  /**
   * Idle-session policy: condense first, hand off only when condensing cannot
   * bring the session back under its recommendation point.
   *
   * Condensation is always on (there is no switch for it); the workspace switch
   * only decides whether a new session is created afterwards.
   * @param {object} agent - idle agent whose session is inspected.
   * @returns {Promise<void>}
   */
  async maybeAuto(agent) {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || this.active.has(sessionId)) return
    if (typeof agent.status === 'string' && agent.status !== 'idle') return
    if (agent.session?.header?.origin === 'subagent' || agent.session?.header?.parentSession !== undefined) return
    let snapshot
    try {
      snapshot = await this.inspect(agent, { horizon: this.config.horizonTurns })
    } catch (error) {
      this.ctx.logger?.warn?.(`context-handoff: auto inspection failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (!snapshot.plan.useful || snapshot.promptTokens < snapshot.plan.recommendedAt) return

    // 1) Condense an over-threshold session first. It keeps the same session,
    //    costs one summarization call, and usually drops the context to the
    //    summary plus the newest node.
    if (this.canCompact(agent, sessionId)) {
      const condensed = await this.compactSession(agent, snapshot, sessionId)
      if (condensed !== undefined) {
        snapshot = condensed
        if (snapshot.promptTokens < snapshot.plan.recommendedAt) return
        this.ctx.logger?.info?.(
          `context-handoff: session ${sessionId} is still at ${snapshot.promptTokens} tokens after condensing; falling back to a handoff`,
        )
      }
    }

    // 2) Condensing is unavailable, exhausted, or did not free enough: hand off.
    //    The switch gates this step only.
    if (!snapshot.auto) return
    const previous = this.lastAuto.get(sessionId)
    if (previous !== undefined) {
      if (previous.completed === true) return
      if (snapshot.promptTokens - previous.tokens < this.config.autoMinGrowthTokens) return
      if (Date.now() - previous.at < this.config.autoCooldownMinutes * 60000) return
    }
    const latest = await latestHandoff(snapshot.outputDir)
    if (latest !== undefined && Date.now() - latest.mtimeMs < this.config.autoCooldownMinutes * 60000) return
    this.lastAuto.set(sessionId, { tokens: snapshot.promptTokens, at: Date.now() })
    try {
      const result = await this.generate(agent, {
        trigger: 'auto',
        newSession: this.config.autoNewSession,
      })
      this.lastAuto.set(sessionId, { tokens: snapshot.promptTokens, at: Date.now(), completed: true })
      if (result.newSessionId !== undefined) {
        this.lastAutoBySource.set(sessionId, {
          newSessionId: result.newSessionId,
          file: result.relativePath,
          at: Date.now(),
        })
        while (this.lastAutoBySource.size > 50) {
          const oldest = this.lastAutoBySource.keys().next().value
          if (oldest === undefined) break
          this.lastAutoBySource.delete(oldest)
        }
      }
      this.ctx.logger?.info?.(
        `context-handoff: auto wrote ${result.relativePath}${result.newSessionId === undefined ? '' : ` and started session ${result.newSessionId}`}`,
      )
    } catch (error) {
      this.ctx.logger?.warn?.(
        `context-handoff: auto handoff failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Resolve the composition's compaction service.
   *
   * Injection is the preferred path, but a plugin mounted in a narrower scope
   * can miss the late-provided service; asking the context directly keeps the
   * feature working instead of silently falling back to a handoff.
   * @returns {object | undefined}
   */
  compactionService(agent) {
    // Agents are assembled from presets, and a preset's compaction backend is
    // mounted in that agent's isolated scope, so the agent context is the one
    // that can see it. It is read per call and never cached: two sessions may
    // run under different presets with different backends.
    let scoped
    try {
      scoped = agent?.ctx?.compaction
    } catch {
      scoped = undefined
    }
    if (scoped !== undefined) {
      this.compactionSource = 'agent'
      return scoped
    }
    if (this.compaction !== undefined) return this.compaction
    let service
    try {
      service = this.ctx.get?.('compaction')
    } catch {
      service = undefined
    }
    if (service === undefined) {
      try {
        service = this.ctx.compaction
      } catch {
        service = undefined
      }
    }
    if (service !== undefined) {
      this.compaction = service
      this.compactionSource = 'context'
    }
    return service
  }

  /**
   * Whether this session still has condensation budget left.
   * @param {string} sessionId - session being considered.
   * @returns {boolean}
   */
  canCompact(agent, sessionId) {
    if (this.compactionService(agent) === undefined) return false
    const budget = this.config.maxCompactionsPerSession
    if (!(budget > 0)) return false
    const used = this.compactions.get(sessionId)
    if (used === undefined) return true
    if (used.count >= budget) return false
    // A condense attempt that just failed must not immediately retry.
    if (used.failedAt !== undefined && Date.now() - used.failedAt < 60000) return false
    return true
  }

  /**
   * Condense one over-threshold session through the composition's compaction
   * service, then re-measure it.
   *
   * The policy is deliberately bounded: a session may be condensed at most
   * `maxCompactionsPerSession` times, and a condense that frees less than 10%
   * of the context counts as the last one, because repeating it would only
   * produce a summary of a summary without buying headroom.
   * @param {object} agent - idle agent owning the session.
   * @param {object} snapshot - measurement taken before condensing.
   * @param {string} sessionId - session identity.
   * @returns {Promise<object | undefined>} the post-condense snapshot, when it ran.
   */
  async compactSession(agent, snapshot, sessionId) {
    const service = this.compactionService(agent)
    if (service === undefined) return undefined
    if (this.compacting.has(sessionId)) return undefined
    this.compacting.add(sessionId)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('compaction timed out')), 15 * 60000)
    timer.unref?.()
    const used = this.compactions.get(sessionId)
    const before = snapshot.promptTokens
    let result
    try {
      result = await service.compactNow(agent, controller.signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger?.warn?.(`context-handoff: condensing skipped: ${message}`)
      this.compactions.set(sessionId, { count: used?.count ?? 0, lastAt: Date.now(), before, after: before, saved: 0, failedAt: Date.now() })
      return undefined
    } finally {
      clearTimeout(timer)
      this.compacting.delete(sessionId)
    }
    if (result === null || result === undefined) return undefined

    let after
    try {
      after = await this.inspect(agent, { horizon: this.config.horizonTurns })
    } catch (error) {
      this.ctx.logger?.warn?.(`context-handoff: post-compaction inspection failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    const count = (used?.count ?? 0) + 1
    const saved = Math.max(0, before - after.promptTokens)
    // A condense that buys nothing is the last one this session gets.
    const exhausted = before > 0 && after.promptTokens >= before * 0.9
    this.compactions.set(sessionId, {
      count: exhausted ? this.config.maxCompactionsPerSession : count,
      lastAt: Date.now(),
      before,
      after: after.promptTokens,
      saved,
    })
    this.ctx.logger?.info?.(
      `context-handoff: condensed session ${sessionId} from ${before} to ${after.promptTokens} tokens (${count}/${this.config.maxCompactionsPerSession})`,
    )
    return after
  }

}

/** Combine optional abort signals without requiring AbortSignal.any. */
function combineSignals(...signals) {
  const list = signals.filter((signal) => signal !== undefined && signal !== null)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)
  const controller = new AbortController()
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

function hasSummarizableContent(messages) {
  return messages.some((message) =>
    (message.content ?? []).some((block) => block?.type === 'tool-call' || (block?.type === 'text' && block.text.trim().length > 0)),
  )
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export { Config, resolveConfig }
export const name = 'context-handoff'
