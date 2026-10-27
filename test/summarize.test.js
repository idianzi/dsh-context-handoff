import assert from 'node:assert/strict'
import test from 'node:test'
import { buildInstruction, buildSummaryRequest, resolveSummaryTarget, streamSummary } from '../lib/summarize.js'
import { resolveConfig } from '../lib/config.js'

const meter = {
  estimateMessage: (message) => Math.ceil(JSON.stringify(message.content).length / 4) + 4,
}

function messages(count) {
  const result = [
    { role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Build the feature.' }] },
  ]
  for (let index = 0; index < count; index += 1) {
    result.push({ role: 'assistant', content: [{ type: 'text', text: `step ${index} `.repeat(80) }] })
    result.push({ role: 'user', content: [{ type: 'text', text: `follow-up ${index} `.repeat(40) }] })
  }
  return result
}

test('summarize: replay when the conversation fits the window', () => {
  const config = resolveConfig({})
  const target = { provider: 'p', model: 'm', windowTokens: 128000 }
  const request = buildSummaryRequest({
    messages: messages(2),
    target,
    config,
    meter,
    instruction: 'Write a handoff.',
    maxOutputTokens: 2000,
    tools: [{ name: 'read', description: '', parameters: { type: 'object' } }],
    toolHistory: [],
  })
  assert.equal(request.mode, 'replay')
  assert.equal(request.messages.at(-1).role, 'user')
  assert.equal(request.tools.length, 1)
  assert.equal(request.maxOutputTokens, 2000)
})

test('summarize: switches to a budgeted transcript when replay cannot fit', () => {
  const config = resolveConfig({})
  const target = { provider: 'p', model: 'm', windowTokens: 8000 }
  const request = buildSummaryRequest({
    messages: messages(200),
    target,
    config,
    meter,
    instruction: 'Write a handoff.',
    maxOutputTokens: 1000,
  })
  assert.equal(request.mode, 'transcript')
  assert.equal(request.messages.length, 1)
  assert.match(request.messages[0].content[0].text, /BEGIN TRANSCRIPT/)
  assert.equal(request.tools, undefined)
  assert.ok(request.omittedMessages > 0)
})

test('summarize: instruction follows the requested language', () => {
  assert.match(buildInstruction({ budgetTokens: 2000, language: 'zh', title: '交接', promptTokens: 90000 }), /## 下一步/)
  assert.match(buildInstruction({ budgetTokens: 2000, language: 'en', title: 'Handoff', promptTokens: 90000 }), /## Next steps/)
})

test('summarize: missing route is a clear error', async () => {
  const ctx = { llm: { resolveModelInfo: async () => ({}) } }
  await assert.rejects(
    resolveSummaryTarget({ ctx, agent: { session: { requestHeader: () => undefined }, options: {} }, config: resolveConfig({}) }),
    /no provider\/model available/,
  )
})

test('summarize: terminal error finish becomes a thrown coded error', async () => {
  const ctx = {
    llm: {
      async *stream() {
        yield { type: 'text-delta', text: 'partial' }
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } }
      },
    },
  }
  const agent = { session: { id: 's', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }
  await assert.rejects(
    streamSummary({
      ctx,
      agent,
      config: resolveConfig({}),
      target: { provider: 'p', model: 'm' },
      request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxOutputTokens: 100 },
    }),
    (error) => error.code === 'RATE_LIMIT' && /slow down/.test(error.message),
  )
})
