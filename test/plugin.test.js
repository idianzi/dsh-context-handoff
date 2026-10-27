import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import ContextHandoff from '../lib/index.js'
import { readHandoffMeta } from '../lib/files.js'

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

function makeMeter() {
  return {
    measure: () => ({ totalTokens: 120000, surfaceTokens: 108000, nodes: [] }),
    estimateMessage: (message) => Math.ceil(JSON.stringify(message.content).length / 4) + 4,
  }
}

function makeCtx({ stream, resolveModelInfo } = {}) {
  const registered = []
  const calls = { stream: [] }
  const llm = {
    async resolveModelInfo() {
      return resolveModelInfo === undefined ? { context: { contextWindow: 128000 }, defaultMaxTokens: 8192 } : resolveModelInfo()
    },
    async *stream(options) {
      calls.stream.push(options)
      yield* stream === undefined
        ? (async function* () {
            yield { type: 'text-delta', text: '# Handoff: Token plugin\n\n## Mission\nBuild it.\n\n## Next steps\n- Run tests.' }
            yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        : stream(options)
    },
  }
  const ctx = {
    commands: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    llm,
    tokenMeter: makeMeter(),
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const result = fn()
      if (result !== undefined && typeof result.next === 'function') {
        let step = result.next()
        while (!step.done) step = result.next()
      }
    },
    get() {
      return undefined
    },
    on() {
      return () => {}
    },
  }
  return { ctx, registered, calls }
}

function makeAgent(root, overrides = {}) {
  const session = {
    id: 'sess-handoff-1234',
    header: { cwd: root },
    seq: 5,
    deriveMessages: () => messages,
    requestHeader: () => ({
      config: { provider: 'test-provider', model: 'test-model', maxTokens: 4096 },
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    }),
    toolHistory: () => [],
  }
  return {
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    status: 'idle',
    async runMaintenance(fn) {
      return fn(new AbortController().signal)
    },
    ...overrides,
  }
}

test('plugin: plan, now, status, list, stats, and the written file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-plugin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { ctx, registered, calls } = makeCtx()
  new ContextHandoff(ctx, { outputDir: '.dsh/handoff' })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'handoff')
  const agent = makeAgent(root)
  const invocation = (rawInput) => ({ agent, rawInput, signal: new AbortController().signal })

  const plan = await registered[0].handler(invocation('plan'))
  assert.equal(plan.kind, 'success')
  assert.match(plan.text, /Context: 120k \/ 128k/)
  assert.match(plan.text, /Recommended now/)
  assert.match(plan.text, /Recommendation point: 70.4k/)

  const now = await registered[0].handler(invocation('now'))
  assert.equal(now.kind, 'success')
  assert.match(now.text, /Handoff written: \.dsh\/handoff\//)
  assert.match(now.text, /generator: llm/)
  assert.match(now.text, /Read @\.dsh\/handoff\//)

  const dir = path.join(root, '.dsh/handoff')
  const files = await readdir(dir)
  assert.ok(files.some((name) => name.endsWith('.md')))
  const file = files.find((name) => name.endsWith('.md'))
  const content = await readFile(path.join(dir, file), 'utf8')
  assert.match(content, /^---\ndsh_handoff: 1/m)
  assert.match(content, /generator: "llm"/)
  assert.match(content, /# Handoff: Token plugin/)
  assert.match(content, /Resume in a new session/)
  const meta = await readHandoffMeta(path.join(dir, file))
  assert.equal(meta.source_tokens, 120000)
  assert.equal(meta.budget_tokens, 3000)
  assert.equal(meta.generator, 'llm')
  assert.equal(meta.summary_mode, 'replay')
  assert.ok(meta.digest_tokens > 0)

  // The summarization call replays messages and reuses the tool declarations.
  assert.equal(calls.stream.length, 1)
  assert.equal(calls.stream[0].maxTokens > 0, true)
  assert.equal(calls.stream[0].tools.length, 1)

  const status = await registered[0].handler(invocation('status'))
  assert.match(status.text, /Latest: \.dsh\/handoff\//)

  const listed = await registered[0].handler(invocation('list'))
  assert.match(listed.text, /Handoff files \(1 total\)/)

  const stats = await registered[0].handler(invocation('stats'))
  assert.match(stats.text, /Handoff ledger: 1 recorded generation/)

  const unknown = await registered[0].handler(invocation('nope'))
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /Unknown \/handoff subcommand/)
})

test('plugin: an explicit budget is honored and the file stays near it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-budget-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { ctx, registered } = makeCtx()
  new ContextHandoff(ctx, { outputDir: '.dsh/handoff' })
  const agent = makeAgent(root)
  const result = await registered[0].handler({ agent, rawInput: 'now 600', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  const dir = path.join(root, '.dsh/handoff')
  const file = (await readdir(dir)).find((name) => name.endsWith('.md'))
  const meta = await readHandoffMeta(path.join(dir, file))
  assert.equal(meta.budget_tokens, 600)
  assert.ok(meta.digest_tokens <= 800)
})

test('plugin: falls back to a deterministic digest when the model fails', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-fallback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { ctx, registered } = makeCtx({
    stream: async function* () {
      throw new Error('RATE_LIMIT: provider unavailable')
    },
  })
  new ContextHandoff(ctx, { outputDir: '.dsh/handoff' })
  const agent = makeAgent(root)
  const result = await registered[0].handler({ agent, rawInput: 'now', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /generator: fallback/)
  assert.match(result.text, /Fallback reason: RATE_LIMIT/)

  const dir = path.join(root, '.dsh/handoff')
  const file = (await readdir(dir)).find((name) => name.endsWith('.md'))
  const content = await readFile(path.join(dir, file), 'utf8')
  assert.match(content, /generator: "fallback"/)
  assert.match(content, /## Mission/)
  assert.match(content, /## Next steps/)
})

test('plugin: redacts credentials from the written file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-redact-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { ctx, registered } = makeCtx({
    stream: async function* () {
      yield { type: 'text-delta', text: '# Handoff: Secrets\n\n## Mission\napi_key = "sk-abcdefghijklmnop123456"\n' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  new ContextHandoff(ctx, { outputDir: '.dsh/handoff' })
  const agent = makeAgent(root)
  const result = await registered[0].handler({ agent, rawInput: 'now', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  const dir = path.join(root, '.dsh/handoff')
  const file = (await readdir(dir)).find((name) => name.endsWith('.md'))
  const content = await readFile(path.join(dir, file), 'utf8')
  assert.doesNotMatch(content, /sk-abcdefghijklmnop123456/)
  assert.match(content, /\[REDACTED\]/)
})

test('plugin: reports busy instead of corrupting an active turn', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-busy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { ctx, registered } = makeCtx()
  new ContextHandoff(ctx, { outputDir: '.dsh/handoff' })
  const agent = makeAgent(root, {
    async runMaintenance() {
      throw new Error('agent already has active work')
    },
  })
  const result = await registered[0].handler({ agent, rawInput: 'now', signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /not idle/)
})

test('plugin: auto mode writes at the recommendation point and then respects growth', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-auto-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { ctx } = makeCtx()
  const plugin = new ContextHandoff(ctx, {
    outputDir: '.dsh/handoff',
    auto: true,
    autoCooldownMinutes: 0,
    autoMinGrowthTokens: 8000,
  })
  const agent = makeAgent(root)
  await plugin.maybeAuto(agent)
  const dir = path.join(root, '.dsh/handoff')
  assert.equal((await readdir(dir)).filter((name) => name.endsWith('.md')).length, 1)

  // Same token count: growth guard prevents a second file.
  await plugin.maybeAuto(agent)
  assert.equal((await readdir(dir)).filter((name) => name.endsWith('.md')).length, 1)
})

test('plugin: auto mode ignores subagent sessions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-subagent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { ctx } = makeCtx()
  const plugin = new ContextHandoff(ctx, { outputDir: '.dsh/handoff', auto: true, autoCooldownMinutes: 0 })
  const agent = makeAgent(root)
  agent.session.header.origin = 'subagent'
  await plugin.maybeAuto(agent)
  await assert.rejects(readdir(path.join(root, '.dsh/handoff')), /ENOENT/)
})

test('plugin: loads without a command registry so auto mode can still run', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-nocmd-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { ctx } = makeCtx()
  delete ctx.commands
  const plugin = new ContextHandoff(ctx, { outputDir: '.dsh/handoff', auto: true, autoCooldownMinutes: 0 })
  const agent = makeAgent(root)
  await plugin.maybeAuto(agent)
  assert.equal((await readdir(path.join(root, '.dsh/handoff'))).filter((name) => name.endsWith('.md')).length, 1)
})

function makeMutableMeter(state) {
  return {
    measure: () => ({
      totalTokens: state.tokens,
      surfaceTokens: Math.max(0, state.tokens - 12000),
      nodes: [],
    }),
    estimateMessage: (message) => Math.ceil(JSON.stringify(message.content).length / 4) + 4,
  }
}

test('plugin: condenses an over-threshold session instead of handing it off', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-compact-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = { tokens: 120000 }
  const { ctx } = makeCtx()
  ctx.tokenMeter = makeMutableMeter(state)
  const plugin = new ContextHandoff(ctx, { outputDir: '.dsh/handoff', auto: true, autoCooldownMinutes: 0 })
  let compactions = 0
  plugin.compaction = {
    async compactNow() {
      compactions += 1
      state.tokens = 20000
      return { shadowedTokenCount: 92000 }
    },
  }
  const agent = makeAgent(root)
  await plugin.maybeAuto(agent)

  assert.equal(compactions, 1)
  // The session recovered below its recommendation point, so no handoff file.
  await assert.rejects(readdir(path.join(root, '.dsh/handoff')), /ENOENT/)
  const record = plugin.compactions.get(agent.session.id)
  assert.equal(record.count, 1)
  assert.equal(record.before, 120000)
  assert.equal(record.after, 20000)
  assert.equal(record.saved, 100000)
})

test('plugin: falls back to a handoff when condensing cannot free enough', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-compact-fallback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = { tokens: 120000 }
  const { ctx } = makeCtx()
  ctx.tokenMeter = makeMutableMeter(state)
  const plugin = new ContextHandoff(ctx, { outputDir: '.dsh/handoff', auto: true, autoCooldownMinutes: 0 })
  plugin.compaction = {
    async compactNow() {
      // Only a small reduction: the summary is not smaller enough to help.
      state.tokens = 118000
      return { shadowedTokenCount: 2000 }
    },
  }
  const agent = makeAgent(root)
  await plugin.maybeAuto(agent)

  const dir = path.join(root, '.dsh/handoff')
  assert.equal((await readdir(dir)).filter((name) => name.endsWith('.md')).length, 1)
  // A condense that frees almost nothing ends this session's budget.
  assert.equal(plugin.compactions.get(agent.session.id).count, plugin.config.maxCompactionsPerSession)
})

test('plugin: condensing stays automatic even when the handoff switch is off', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-compact-noswitch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = { tokens: 120000 }
  const { ctx } = makeCtx()
  ctx.tokenMeter = makeMutableMeter(state)
  const plugin = new ContextHandoff(ctx, { outputDir: '.dsh/handoff', auto: false })
  let compactions = 0
  plugin.compaction = {
    async compactNow() {
      compactions += 1
      state.tokens = 20000
      return { shadowedTokenCount: 100000 }
    },
  }
  const agent = makeAgent(root)
  await plugin.maybeAuto(agent)

  assert.equal(compactions, 1)
  await assert.rejects(readdir(path.join(root, '.dsh/handoff')), /ENOENT/)
})

test('plugin: stops condensing after the per-session budget', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-compact-budget-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = { tokens: 120000 }
  const { ctx } = makeCtx()
  ctx.tokenMeter = makeMutableMeter(state)
  const plugin = new ContextHandoff(ctx, {
    outputDir: '.dsh/handoff',
    auto: true,
    autoCooldownMinutes: 0,
    autoMinGrowthTokens: 1,
    maxCompactionsPerSession: 2,
  })
  let compactions = 0
  plugin.compaction = {
    async compactNow() {
      compactions += 1
      state.tokens = 20000
      return { shadowedTokenCount: 100000 }
    },
  }
  const agent = makeAgent(root)

  // Cycle 1: condense, then the session grows back over the threshold.
  await plugin.maybeAuto(agent)
  assert.equal(compactions, 1)
  state.tokens = 120000
  await plugin.maybeAuto(agent)
  assert.equal(compactions, 2)

  // Cycle 3: budget is gone, so the fallback handoff runs instead.
  state.tokens = 120000
  await plugin.maybeAuto(agent)
  assert.equal(compactions, 2)
  const dir = path.join(root, '.dsh/handoff')
  assert.equal((await readdir(dir)).filter((name) => name.endsWith('.md')).length, 1)
})
