import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AutoStateStore } from '../lib/auto-state.js'
import { resolveConfig } from '../lib/config.js'

test('auto-state: default, explicit on, explicit off', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-auto-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new AutoStateStore(resolveConfig({ auto: false }))
  const first = await store.read(root)
  assert.equal(first.auto, false)
  assert.equal(first.explicit, false)

  await store.write(root, true)
  const on = await store.read(root)
  assert.equal(on.auto, true)
  assert.equal(on.explicit, true)
  const body = JSON.parse(await readFile(path.join(root, '.dsh/handoff/auto.json'), 'utf8'))
  assert.equal(body.auto, true)

  await store.write(root, false)
  assert.equal((await store.read(root)).auto, false)
})

test('auto-state: config default applies when no file exists', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-auto-default-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new AutoStateStore(resolveConfig({ auto: true }))
  assert.equal((await store.read(root)).auto, true)
})
