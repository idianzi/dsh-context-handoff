import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFallbackBody,
  detectLanguage,
  enforceFileBudget,
  extractTitle,
  fitTranscript,
  priceHandoff,
  redactSecrets,
  renderHandoffFile,
  renderMessage,
  resolveLanguage,
  sanitizeModelMarkdown,
  truncateMiddle,
} from '../lib/digest.js'

const messages = [
  { role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }] },
  { role: 'user', content: [{ type: 'text', text: 'Build a token-aware handoff plugin with tests.' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'I will inspect the repo first.' },
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"package.json"}' },
    ],
  },
  { role: 'tool', content: [{ type: 'text', text: 'package contents' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Implemented and tested.' }] },
]

const meter = {
  estimateMessage: (message) => Math.ceil(JSON.stringify(message.content).length / 4) + 4,
}

test('redactSecrets removes common credentials but not prose', () => {
  const text = 'api_key = "sk-abcdefghijklmnop123456"\nthe token count is 1200\npassword: hunter2hunter2'
  const redacted = redactSecrets(text)
  assert.match(redacted, /\[REDACTED\]/)
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnop123456/)
  assert.match(redacted, /the token count is 1200/)
  assert.doesNotMatch(redacted, /hunter2hunter2/)
})

test('renderMessage keeps tool context and can hide arguments', () => {
  const assistant = messages[2]
  assert.match(renderMessage(assistant), /\[assistant\]/)
  assert.match(renderMessage(assistant), /read/)
  assert.match(renderMessage(assistant), /package\.json/)
  assert.doesNotMatch(renderMessage(assistant, { includeToolDetails: false }), /package\.json/)
})

test('fitTranscript keeps the first user request and the newest messages', () => {
  const fitted = fitTranscript(messages, { budgetTokens: 76, meter })
  assert.ok(fitted.included >= 2)
  assert.ok(fitted.included < messages.length)
  assert.ok(fitted.text.includes('Build a token-aware handoff plugin'))
  assert.ok(fitted.text.includes('Implemented and tested'))
  assert.match(fitted.text, /earlier message/)
})

test('detectLanguage and resolveLanguage', () => {
  const zh = [{ role: 'user', content: [{ type: 'text', text: '请帮我总结一下当前会话，然后生成一个交接文件。' }] }]
  assert.equal(detectLanguage(zh), 'zh')
  assert.equal(resolveLanguage('auto', zh), 'zh')
  assert.equal(resolveLanguage('en', zh), 'en')
  assert.equal(detectLanguage(messages), 'en')
})

test('extractTitle uses the first user request', () => {
  assert.equal(extractTitle(messages, 'sess-123'), 'Build a token-aware handoff plugin with tests.')
  assert.equal(extractTitle([], 'sess-12345678'), 'Session sess-123')
})

test('sanitizeModelMarkdown removes a wrapping fence and preamble', () => {
  assert.equal(sanitizeModelMarkdown('```markdown\n# Handoff\n\nbody\n```'), '# Handoff\n\nbody')
  assert.equal(sanitizeModelMarkdown('Here is the handoff:\n\n# Handoff\n\nbody'), '# Handoff\n\nbody')
})

test('truncateMiddle preserves both ends', () => {
  const source = `head\n${'x'.repeat(5000)}\ntail`
  const out = truncateMiddle(source, 500)
  assert.ok(out.startsWith('head'))
  assert.ok(out.endsWith('tail'))
  assert.match(out, /trimmed to fit/)
})

test('buildFallbackBody is self-contained and language aware', () => {
  const en = buildFallbackBody({
    title: 'Token plugin',
    messages,
    language: 'en',
    stats: { promptTokens: 120000, created: '2026-01-01T00:00:00.000Z' },
  })
  assert.match(en, /^# Handoff: Token plugin/m)
  assert.match(en, /## Mission/)
  assert.match(en, /## Next steps/)
  assert.match(en, /read/)

  const zh = buildFallbackBody({
    title: '交接',
    messages,
    language: 'zh',
    stats: { promptTokens: 120000, created: '2026-01-01T00:00:00.000Z' },
  })
  assert.match(zh, /^# 会话交接：交接/m)
  assert.match(zh, /## 下一步/)
})

test('renderHandoffFile emits frontmatter and a resume card', () => {
  const text = renderHandoffFile({
    meta: { dsh_handoff: 1, session: 'sess-1', digest_tokens: 100, cwd: '/work', created: '2026-01-01T00:00:00.000Z' },
    body: '# Handoff: X\n\n## Next steps\n- go',
    cwd: '/work',
    relativePath: '.dsh/handoff/x.md',
    title: 'X',
  })
  assert.match(text, /^---\ndsh_handoff: 1/m)
  assert.match(text, /Resume in a new session/)
  assert.match(text, /Read @\.dsh\/handoff\/x\.md/)
  assert.match(text, /# Handoff: X/)
})

test('enforceFileBudget trims an oversized body', () => {
  const budget = 400
  const body = `# Handoff: X\n\n## Mission\n${'long '.repeat(5000)}\n\n## Next steps\n- go`
  const result = enforceFileBudget({
    meta: { dsh_handoff: 1, session: 'sess-1', budget_tokens: budget },
    body,
    cwd: '/work',
    relativePath: '.dsh/handoff/x.md',
    title: 'X',
    budgetTokens: budget,
    meter,
  })
  assert.equal(result.truncated, true)
  assert.ok(result.tokens <= budget)
  assert.ok(priceHandoff(meter, result.text) <= budget)
  assert.match(result.text, /## Next steps/)
})
