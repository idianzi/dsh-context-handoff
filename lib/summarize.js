/**
 * Model-facing summarization for dsh-context-handoff.
 *
 * Preferred path: replay the session's model-visible messages and append the
 * handoff instruction, so the provider's warm prefix cache covers the bulk of
 * the input. Fallback path: a budgeted plain-text transcript, used when the
 * conversation is too large for the model window or contains non-text blocks
 * that should not be sent again.
 *
 * @module dsh-context-handoff/summarize
 */
import { estimateTextTokens, fitTranscript, priceMessage } from './digest.js'

/** Stable, model-facing instructions. Kept in one place for review and tests. */
export function buildInstruction({ budgetTokens, language, title, promptTokens }) {
  const zh = language === 'zh'
  const headings = zh
    ? ['# 会话交接：<标题>', '## 目标', '## 当前状态', '## 关键决策', '## 文件与代码', '## 验证', '## 未解决问题', '## 下一步', '## 约束与偏好', '## 重要背景']
    : [
        '# Handoff: <title>',
        '## Mission',
        '## Current state',
        '## Key decisions',
        '## Files and code',
        '## Verification',
        '## Open issues',
        '## Next steps',
        '## Constraints and preferences',
        '## Important context',
      ]
  const rules = zh
    ? [
        '- 只输出 Markdown，不要输出前言、解释或代码围栏。',
        '- 这是一份给"完全没有当前对话记录的新会话"的交接文档，必须自包含。',
        '- 保留精确的文件路径、命令、错误字符串、标识符、数字和用户原话；不确定的内容标注"未知"。',
        '- 不要编造未发生的工作；不要提到"总结""压缩"或这条指令。',
        '- 用密集的要点而不是长篇叙述；删掉寒暄和重复内容。',
        '- 如果对话中已有更早的交接文档，只保留仍然成立的事实，合并成一份。',
        '- 不要包含 API key、密码、令牌或私钥；需要时写"见原会话的凭据配置"。',
      ]
    : [
        '- Output Markdown only: no preamble, explanation, or code fence.',
        '- This document is for a fresh session with no access to the current conversation; it must be self-contained.',
        '- Preserve exact file paths, commands, error strings, identifiers, numbers, and user wording; mark anything uncertain as unknown.',
        '- Do not invent work that did not happen, and do not mention summarization, compaction, or this instruction.',
        '- Prefer dense bullets over prose; drop greetings and repetition.',
        '- If the conversation already contains an earlier handoff, keep only still-true facts and merge them into one document.',
        '- Never include API keys, passwords, tokens, or private keys; point to the original credential configuration instead.',
      ]
  return [
    zh ? '你是一位资深工程师，正在为接手工作的同事写交接文档。' : 'You are a senior engineer writing a handoff document for a colleague who will take over.',
    '',
    zh ? `原会话上下文约为 ${promptTokens} tokens。请写一份不超过约 ${budgetTokens} tokens 的交接文档。` : `The source conversation is about ${promptTokens} tokens. Write a handoff of at most about ${budgetTokens} tokens.`,
    zh ? `建议标题：${title}` : `Suggested title: ${title}`,
    '',
    zh ? '严格使用以下结构（标题可以按内容微调，但顺序保持一致）：' : 'Use this structure exactly (headings may be refined, but keep the order):',
    ...headings,
    '',
    zh ? '规则：' : 'Rules:',
    ...rules,
    '',
    zh ? '优先写入：用户真正的目标与验收标准、已经做出的决定及理由、改过的文件、运行过的命令与结果、仍未解决的问题、下一步的第一个动作。' : 'Prioritize: the real goal and acceptance criteria, decisions and their rationale, changed files, commands run and their results, unresolved issues, and the first next action.',
  ].join('\n')
}

/**
 * Resolve the summarization route and its context window.
 * @param {object} input
 * @param {object} input.ctx
 * @param {object} input.agent
 * @param {object} input.config
 * @param {AbortSignal} [input.signal]
 * @param {Map<string, number | undefined>} [input.cache] - per-route window cache.
 * @returns {Promise<{provider: string, model: string, windowTokens?: number, routeMaxTokens?: number}>}
 */
export async function resolveSummaryTarget({ ctx, agent, config, signal, cache }) {
  const header = agent?.session?.requestHeader?.()
  const routed = header?.config
  const provider = config.provider || routed?.provider || agent?.options?.provider
  const model = config.model || routed?.model || agent?.options?.model
  if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
    throw new Error('no provider/model available; route one request first or set the provider and model config fields')
  }
  const key = `${provider}\u0000${model}`
  let windowTokens
  if (cache?.has(key)) {
    windowTokens = cache.get(key)
  } else {
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model, signal)
      windowTokens = info?.context?.contextWindow
    } catch {
      // A route can stream even when optional metadata lookup fails; the
      // comparison then omits the window rather than blocking the handoff.
    }
    cache?.set(key, windowTokens)
  }
  return {
    provider,
    model,
    windowTokens,
    routeMaxTokens: typeof routed?.maxTokens === 'number' && routed.maxTokens > 0 ? routed.maxTokens : undefined,
  }
}

/**
 * Replace non-text blocks in a message copy. Text-only summaries do not need
 * to re-send image bytes or file references.
 */
function stripNonText(messages) {
  let changed = false
  const next = []
  for (const message of messages) {
    const content = []
    let messageChanged = false
    for (const block of message.content ?? []) {
      if (block?.type === 'text' || block?.type === 'tool-call') {
        content.push(block)
      } else if (block?.type === 'image') {
        content.push({ type: 'text', text: '[image omitted from handoff summary]' })
        messageChanged = true
      } else if (block?.type === 'file') {
        content.push({ type: 'text', text: `[file: ${block?.attachment?.name ?? block?.name ?? 'file'}]` })
        messageChanged = true
      } else if (block?.type === 'reasoning') {
        messageChanged = true
      } else {
        content.push(block)
      }
    }
    if (content.length === 0) {
      changed = true
      continue
    }
    next.push(messageChanged ? { ...message, content } : message)
    if (messageChanged) changed = true
  }
  return changed ? next : messages
}

/** Sum the meter price of a message list. */
function priceMessages(meter, messages) {
  let total = 0
  for (const message of messages) total += priceMessage(meter, message)
  return total
}

/**
 * Build the request messages for the summarization call.
 * @param {object} input
 * @param {object[]} input.messages - session-derived model messages.
 * @param {object} input.target
 * @param {object} input.config
 * @param {object} input.meter
 * @param {string} input.instruction
 * @param {number} input.maxOutputTokens
 * @param {object} [input.toolHistory]
 * @returns {{messages: object[], tools?: object[], mode: 'replay'|'transcript', estimatedInputTokens: number, omittedMessages: number}}
 */
export function buildSummaryRequest({ messages, target, config, meter, instruction, maxOutputTokens, toolHistory, tools }) {
  const safe = stripNonText(messages)
  const instructionTokens = estimateTextTokens(instruction)
  const windowTokens = target.windowTokens
  if (windowTokens !== undefined) {
    const replayBudget = windowTokens - maxOutputTokens - Math.max(2048, Math.round(windowTokens * 0.05))
    const replayTokens = priceMessages(meter, safe) + instructionTokens
    if (replayTokens <= replayBudget) {
      return {
        messages: [...safe, { role: 'user', content: [{ type: 'text', text: instruction }] }],
        mode: 'replay',
        estimatedInputTokens: replayTokens,
        omittedMessages: 0,
        maxOutputTokens,
        ...(tools === undefined ? {} : { tools }),
        ...(toolHistory === undefined ? {} : { toolHistory }),
      }
    }
  } else {
    // Without a known window, replay when the request is comfortably small.
    const replayTokens = priceMessages(meter, safe) + instructionTokens
    if (replayTokens <= 48000) {
      return {
        messages: [...safe, { role: 'user', content: [{ type: 'text', text: instruction }] }],
        mode: 'replay',
        estimatedInputTokens: replayTokens,
        omittedMessages: 0,
        maxOutputTokens,
        ...(tools === undefined ? {} : { tools }),
        ...(toolHistory === undefined ? {} : { toolHistory }),
      }
    }
  }

  const window = windowTokens ?? 128000
  const transcriptBudget = Math.max(1024, Math.floor(window * config.transcriptBudgetRatio) - maxOutputTokens - instructionTokens)
  const fitted = fitTranscript(safe, {
    budgetTokens: transcriptBudget,
    meter,
    maxCharsPerMessage: 6000,
    includeToolDetails: config.includeToolDetails,
  })
  const header = [
    'The current session is too large to replay verbatim. Below is a budgeted transcript of the model-visible conversation.',
    `Transcript coverage: ${fitted.included} messages included, ${fitted.omitted} omitted.`,
    '',
    '--- BEGIN TRANSCRIPT ---',
    fitted.text,
    '--- END TRANSCRIPT ---',
    '',
    instruction,
  ].join('\n')
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: header }] }],
    mode: 'transcript',
    estimatedInputTokens: estimateTextTokens(header),
    omittedMessages: fitted.omitted,
    maxOutputTokens,
  }
}

/**
 * Stream one summary and return its text plus usage facts.
 * @param {object} input
 * @param {object} input.ctx
 * @param {object} input.agent
 * @param {object} input.config
 * @param {object} input.target
 * @param {object} input.request
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{text: string, usage?: object, finish: object, effectiveTokens?: number}>}
 */
export async function streamSummary({ ctx, agent, config, target, request, signal }) {
  const options = {
    provider: target.provider,
    model: target.model,
    messages: request.messages,
    maxTokens: request.maxOutputTokens,
    ...request.tools === undefined || request.tools.length === 0 ? {} : { tools: request.tools },
    ...request.toolHistory === undefined ? {} : { toolHistory: request.toolHistory },
    sessionId: agent?.session?.id,
    ...signal === undefined ? {} : { signal },
  }
  let text = ''
  let usage
  let finish = { kind: 'stop' }
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk?.type === 'text-delta') text += chunk.text
    else if (chunk?.type === 'usage') usage = chunk.usage
    else if (chunk?.type === 'finish') finish = chunk.reason ?? { kind: 'stop' }
  }
  if (finish?.kind === 'error') {
    const failure = finish.failure
    const code = failure?.code ?? 'LLM_ERROR'
    const message = failure?.message ?? 'the summarization request failed'
    const error = new Error(`${code}: ${message}`)
    error.code = code
    throw error
  }
  if (finish?.kind === 'aborted') {
    const error = new Error('handoff summarization was cancelled')
    error.code = 'ABORTED'
    throw error
  }
  const effectiveTokens =
    usage === undefined
      ? undefined
      : (Number(usage.inputTokens) || 0) +
        (Number(usage.cacheWriteTokens) || 0) +
        (Number(usage.cacheReadTokens) || 0) * config.cacheReadWeight +
        (Number(usage.outputTokens) || 0)
  return { text: text.trim(), usage, finish, effectiveTokens }
}
