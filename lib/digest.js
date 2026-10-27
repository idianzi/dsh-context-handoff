/**
 * Handoff Markdown construction: transcript rendering, budget-aware trimming,
 * deterministic fallback digest, secret redaction, and the final file envelope.
 *
 * Pure functions only; file I/O lives in `files.js` and model calls in
 * `summarize.js`. Everything here is deterministic so it can be unit tested.
 *
 * @module dsh-context-handoff/digest
 */

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u
const LATIN = /[A-Za-z]/u

const SECRET_PATTERNS = [
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, label: '[REDACTED PRIVATE KEY]' },
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, label: '[REDACTED]' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, label: '[REDACTED]' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: '[REDACTED]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: '[REDACTED]' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: '[REDACTED]' },
  {
    re: /(?<=(?:api[_-]?key|secret|token|password|passwd|authorization)\s*[:=]\s*["']?)[^\s"'`,;]{8,}/gi,
    label: '[REDACTED]',
  },
]

/**
 * Redact common credentials from text that will be written to disk.
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let out = text
  for (const { re, label } of SECRET_PATTERNS) out = out.replace(re, label)
  return out
}

/**
 * Estimate tokens without a meter (DSH's estimator uses four characters per
 * token plus a small per-block overhead).
 * @param {string} text
 * @returns {number}
 */
export function estimateTextTokens(text) {
  return Math.ceil(String(text ?? '').length / 4) + 4
}

/**
 * Format a DSH file reference, quoting paths that contain whitespace.
 * @param {string} relativePath
 * @returns {string}
 */
export function fileReference(relativePath) {
  return /[\s"'`]/u.test(relativePath) ? `@"${relativePath.replaceAll('"', '\\"')}"` : `@${relativePath}`
}

/**
 * Price one message through the injected DSH meter, falling back to the local
 * heuristic when the meter is absent or rejects a synthetic message.
 * @param {{estimateMessage?: (message: object) => number} | undefined} meter
 * @param {object} message
 * @returns {number}
 */
export function priceMessage(meter, message) {
  try {
    const value = meter?.estimateMessage?.(message)
    if (Number.isFinite(value) && value >= 0) return value
  } catch {
    // Fall through to the heuristic; a synthetic message may omit fields the
    // meter validates for real session messages.
  }
  return estimateTextTokens(collectText(message?.content))
}

/**
 * Price the final file as if a new session read it as one user message.
 * @param {{estimateMessage?: (message: object) => number} | undefined} meter
 * @param {string} text
 * @returns {number}
 */
export function priceHandoff(meter, text) {
  return priceMessage(meter, { role: 'user', content: [{ type: 'text', text }] })
}

/** Normalize a role label for a transcript line. */
function roleLabel(message) {
  switch (message?.role) {
    case 'assistant':
      return 'assistant'
    case 'tool':
      return 'tool'
    case 'system':
      return 'system'
    case 'developer':
      return 'developer'
    default:
      return 'user'
  }
}

/** Extract plain text from content blocks. */
function collectText(content) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block?.type === 'text') text += block.text
    else if (block?.type === 'reasoning') continue
    else if (block?.type === 'tool-call') text += `${block.name} ${block.arguments ?? ''}`
    else if (typeof block?.text === 'string') text += block.text
  }
  return text
}

/** Trim a string at a line boundary near `limit`, appending an ellipsis. */
function clampText(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  const cut = value.lastIndexOf('\n', limit)
  const end = cut > limit * 0.6 ? cut : limit
  return `${value.slice(0, end).trimEnd()} …`
}

/**
 * Render one message as compact transcript text.
 * @param {object} message
 * @param {{maxChars?: number, includeToolDetails?: boolean}} [options]
 * @returns {string}
 */
export function renderMessage(message, options = {}) {
  const maxChars = options.maxChars ?? 4000
  const includeToolDetails = options.includeToolDetails !== false
  const lines = []
  for (const block of message?.content ?? []) {
    if (block?.type === 'text') {
      if (block.text.trim().length > 0) lines.push(clampText(block.text.trim(), maxChars))
    } else if (block?.type === 'reasoning') {
      continue
    } else if (block?.type === 'tool-call') {
      if (!includeToolDetails) lines.push(`[tool call] ${block.name}`)
      else {
        const args = clampText(String(block.arguments ?? ''), Math.min(maxChars, 800))
        lines.push(`[tool call] ${block.name} ${args}`)
      }
    } else if (block?.type === 'image') {
      lines.push('[image]')
    } else if (block?.type === 'file') {
      const name = block?.attachment?.name ?? block?.name ?? 'file'
      lines.push(`[file: ${name}]`)
    }
  }
  if (lines.length === 0) return ''
  return `[${roleLabel(message)}]\n${lines.join('\n')}`
}

/**
 * Fit a transcript into a token budget while keeping the opening user request
 * and the newest messages. Older middle messages are dropped first.
 *
 * @param {object[]} messages
 * @param {object} options
 * @param {number} options.budgetTokens
 * @param {object} [options.meter]
 * @param {number} [options.maxCharsPerMessage]
 * @param {boolean} [options.includeToolDetails]
 * @returns {{text: string, included: number, omitted: number, tokens: number}}
 */
export function fitTranscript(messages, options) {
  const budgetTokens = Math.max(0, options.budgetTokens)
  const rendered = messages.map((message) =>
    renderMessage(message, {
      maxChars: options.maxCharsPerMessage ?? 4000,
      includeToolDetails: options.includeToolDetails,
    }),
  )
  const prices = rendered.map((text) => (text.length === 0 ? 0 : estimateTextTokens(text)))

  const selected = new Set()
  let used = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const price = prices[index]
    if (price === 0) continue
    if (used + price > budgetTokens && selected.size > 0) continue
    selected.add(index)
    used += price
  }
  // Always anchor the handoff with the first real user request when it fits.
  if (messages.length > 0) {
    const firstUser = messages.findIndex((message) => message?.role === 'user' && renderMessage(message).length > 0)
    if (firstUser >= 0 && !selected.has(firstUser)) {
      const price = prices[firstUser] ?? estimateTextTokens(rendered[firstUser] ?? '')
      if (used + price <= budgetTokens || selected.size === 0) {
        selected.add(firstUser)
        used += price
      }
    }
  }

  const parts = []
  let omitted = 0
  for (let index = 0; index < messages.length; index += 1) {
    if (!selected.has(index)) {
      if (rendered[index]?.length > 0) omitted += 1
      continue
    }
    if (omitted > 0 && parts.length > 0) {
      parts.push(`[${omitted} earlier message${omitted === 1 ? '' : 's'} omitted to fit the summary request]`)
      omitted = 0
    }
    parts.push(rendered[index])
  }
  const text = parts.join('\n\n')
  return { text, included: selected.size, omitted: countOmitted(prices, selected), tokens: estimateTextTokens(text) }
}

function countOmitted(prices, selected) {
  let count = 0
  for (let index = 0; index < prices.length; index += 1) if (prices[index] > 0 && !selected.has(index)) count += 1
  return count
}

/**
 * Pick a short human title from the first user request.
 * @param {object[]} messages
 * @param {string} sessionId
 * @returns {string}
 */
export function extractTitle(messages, sessionId) {
  const firstUser = messages.find((message) => message?.role === 'user' && collectText(message.content).trim().length > 0)
  const raw = firstUser === undefined ? '' : collectText(firstUser.content)
  const title = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 72)
    .trim()
  return title.length > 0 ? title : `Session ${String(sessionId).slice(0, 8)}`
}

/**
 * Detect whether the conversation is predominantly Chinese.
 * @param {object[]} messages
 * @returns {'zh' | 'en'}
 */
export function detectLanguage(messages) {
  let cjk = 0
  let latin = 0
  for (const message of messages.slice(-20)) {
    const text = collectText(message?.content).slice(0, 20000)
    for (const char of text) {
      if (CJK.test(char)) cjk += 1
      else if (LATIN.test(char)) latin += 1
    }
  }
  if (cjk + latin === 0) return 'en'
  return cjk / (cjk + latin) > 0.2 ? 'zh' : 'en'
}

/** Resolve the configured language against the conversation. */
export function resolveLanguage(configLanguage, messages) {
  if (configLanguage === 'en' || configLanguage === 'zh') return configLanguage
  return detectLanguage(messages)
}

/**
 * Strip wrappers and preambles a model may add around the requested Markdown.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeModelMarkdown(text) {
  let out = String(text ?? '').trim()
  const fence = out.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  if (fence !== null) out = fence[1].trim()
  const heading = out.indexOf('\n# ')
  if (heading >= 0 && !out.startsWith('# ')) out = out.slice(heading + 1).trim()
  out = out.replace(/\n{4,}/g, '\n\n\n')
  return out.trim()
}

/**
 * Keep the start and end of a long body, replacing the middle with a marker.
 * This preserves the opening summary and the trailing next-steps section.
 * @param {string} text
 * @param {number} maxChars
 * @param {string} [reason]
 * @returns {string}
 */
export function truncateMiddle(text, maxChars, reason = 'content trimmed to fit the digest budget') {
  const value = String(text ?? '')
  if (value.length <= maxChars) return value
  const marker = `\n\n<!-- ${reason} -->\n\n`
  if (maxChars <= marker.length + 40) return value.slice(0, Math.max(0, maxChars))
  const keep = maxChars - marker.length
  const headBudget = Math.floor(keep * 0.6)
  const tailBudget = keep - headBudget
  const headCut = value.lastIndexOf('\n', headBudget)
  const head = value.slice(0, headCut > headBudget * 0.5 ? headCut : headBudget).trimEnd()
  const tailStartRaw = value.length - tailBudget
  const tailCut = value.indexOf('\n', tailStartRaw)
  const tail = value.slice(tailCut >= 0 ? tailCut + 1 : tailStartRaw).trimStart()
  return `${head}${marker}${tail}`
}

/**
 * Build a deterministic digest when the model is unavailable or fails.
 * It is deliberately conservative: goals, recent dialogue, tools, next action,
 * and statistics, all from data already in the session.
 *
 * @param {object} input
 * @param {string} input.title
 * @param {object[]} input.messages
 * @param {'zh'|'en'} input.language
 * @param {object} input.stats
 * @param {boolean} [input.includeToolDetails]
 * @returns {string}
 */
export function buildFallbackBody({ title, messages, language, stats, includeToolDetails = true }) {
  const zh = language === 'zh'
  const firstUser = messages.find((message) => message?.role === 'user' && collectText(message.content).trim().length > 0)
  const mission = firstUser === undefined ? (zh ? '（未记录）' : '(not captured)') : clampText(collectText(firstUser.content).trim(), 1600)

  const recent = []
  for (const message of messages.slice(-10)) {
    const text = renderMessage(message, { maxChars: 700, includeToolDetails })
    if (text.length > 0) recent.push(text)
  }

  const toolCounts = new Map()
  for (const message of messages) {
    for (const block of message?.content ?? []) {
      if (block?.type !== 'tool-call' || typeof block.name !== 'string') continue
      toolCounts.set(block.name, (toolCounts.get(block.name) ?? 0) + 1)
    }
  }
  const tools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)

  const heading = (en, cn) => `## ${zh ? cn : en}`
  const lines = []
  lines.push(zh ? `# 会话交接：${title}` : `# Handoff: ${title}`)
  lines.push('')
  lines.push(heading('Mission', '目标'))
  lines.push('')
  lines.push(mission)
  lines.push('')
  lines.push(heading('Recent conversation', '最近对话'))
  lines.push('')
  lines.push(recent.length > 0 ? recent.join('\n\n') : zh ? '（无）' : '(none)')
  lines.push('')
  lines.push(heading('Tools used', '使用过的工具'))
  lines.push('')
  lines.push(tools.length > 0 ? tools.map(([name, count]) => `- \`${name}\` × ${count}`).join('\n') : zh ? '- （无）' : '- (none)')
  lines.push('')
  lines.push(heading('Next steps', '下一步'))
  lines.push('')
  lines.push(
    zh
      ? '- 阅读最近对话中提到的文件，确认当前状态后，从最后一条用户请求继续。\n- 如需精确细节，回到原会话查看对应工具输出。'
      : '- Re-read the files named in the recent conversation, confirm the current state, then continue from the last user request.\n- Return to the original session for exact tool output when needed.',
  )
  lines.push('')
  lines.push(heading('Session statistics', '会话统计'))
  lines.push('')
  lines.push(
    zh
      ? `- 原会话上下文：${stats.promptTokens} tokens\n- 摘要生成方式：确定性回退（未调用模型）\n- 生成时间：${stats.created}`
      : `- Source context: ${stats.promptTokens} tokens\n- Digest generator: deterministic fallback (no model call)\n- Created: ${stats.created}`,
  )
  return lines.join('\n')
}

/**
 * Build the final file: YAML frontmatter, a resume card, then the body.
 *
 * @param {object} input
 * @param {object} input.meta - frontmatter fields.
 * @param {string} input.body - Markdown body.
 * @param {string} input.cwd
 * @param {string} input.relativePath
 * @param {string} input.title
 * @param {'en'|'zh'} [input.language]
 * @returns {string}
 */
export function renderHandoffFile({ meta, body, cwd, relativePath, title, language = 'en' }) {
  const frontmatter = renderFrontmatter(meta)
  const zh = language === 'zh'
  const resume = zh
    ? [
        '> **在新会话中继续** — 打开这个工作区，然后发送：',
        `> \`Read ${fileReference(relativePath)} and continue from the "下一步" section.\``,
        '>',
        `> 工作目录：\`${cwd}\``,
      ].join('\n')
    : [
        '> **Resume in a new session** — open this workspace, then send:',
        `> \`Read ${fileReference(relativePath)} and continue from the "Next steps" section.\``,
        '>',
        `> Working directory: \`${cwd}\``,
      ].join('\n')
  let content = body.trim()
  if (!/^#\s/m.test(content)) content = zh ? `# 会话交接：${title}\n\n${content}` : `# Handoff: ${title}\n\n${content}`
  return `${frontmatter}\n${resume}\n\n${content}\n`
}

/** Render a flat YAML frontmatter block. */
export function renderFrontmatter(meta) {
  const lines = ['---']
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue
    lines.push(`${key}: ${yamlScalar(value)}`)
  }
  lines.push('---')
  return lines.join('\n')
}

function yamlScalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(String(value))
}

/**
 * Enforce the whole-file token budget after rendering. The body loses its
 * middle first; frontmatter and the resume card are never dropped.
 *
 * @param {object} input
 * @param {object} input.meta
 * @param {string} input.body
 * @param {string} input.cwd
 * @param {string} input.relativePath
 * @param {string} input.title
 * @param {number} input.budgetTokens
 * @param {object} [input.meter]
 * @param {'en'|'zh'} [input.language]
 * @returns {{text: string, tokens: number, truncated: boolean}}
 */
export function enforceFileBudget({ meta, body, cwd, relativePath, title, budgetTokens, meter, language = 'en' }) {
  let currentBody = body
  let text = renderHandoffFile({ meta, body: currentBody, cwd, relativePath, title, language })
  let tokens = priceHandoff(meter, text)
  let truncated = false
  let attempts = 0
  while (tokens > budgetTokens && currentBody.length > 200 && attempts < 4) {
    const ratio = Math.max(0.25, (budgetTokens / tokens) * 0.94)
    currentBody = truncateMiddle(currentBody, Math.max(200, Math.floor(currentBody.length * ratio)))
    text = renderHandoffFile({ meta, body: currentBody, cwd, relativePath, title, language })
    tokens = priceHandoff(meter, text)
    truncated = true
    attempts += 1
  }
  return { text, tokens, truncated, body: currentBody }
}
