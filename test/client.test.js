import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

test('client bundle registers a sidebar tab and pane body', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let definition
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          definition = value
        },
      },
    },
    console,
  }
  vm.runInNewContext(source, sandbox)
  assert.equal(definition.id, 'dsh-context-handoff')

  const reactStub = {
    createElement() {},
    useCallback(fn) {
      return fn
    },
    useEffect() {},
    useRef(value) {
      return { current: value }
    },
    useState(value) {
      return [typeof value === 'function' ? value() : value, () => {}]
    },
  }
  const exports = definition.factory((id) => {
    assert.equal(id, 'react')
    return reactStub
  })
  assert.equal(exports.name, 'context-handoff-client')
  assert.ok(exports.inject.includes('sidebarRightTabs'))
  assert.ok(exports.inject.includes('sessions'))

  const captured = { tab: undefined, slot: undefined, pane: undefined }
  const ctx = {
    sidebarRightTabs: {
      register(value) {
        captured.tab = value
        return () => {}
      },
    },
    slots: {
      inject(name, callback) {
        captured.slot = name
        return callback()
      },
      register(value, component) {
        captured.pane = { value, component }
        return () => {}
      },
    },
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
    uiWorkspace: { openSession() {} },
    effect(fn) {
      const result = fn()
      if (result !== undefined && typeof result.next === 'function') {
        let step = result.next()
        while (!step.done) step = result.next()
      }
    },
  }
  exports.apply(ctx)
  assert.equal(captured.tab.id, 'dsh-context-handoff/panel')
  assert.equal(captured.tab.kind, 'context-handoff')
  assert.equal(captured.tab.title(), '上下文交接')
  assert.equal(captured.tab.guide[0].title(), '上下文交接')
  assert.equal(captured.slot, 'sidebar.right.pane.tab')
  assert.equal(captured.pane.value.key, 'dsh-context-handoff/panel')
  assert.equal(typeof captured.pane.component, 'function')
})
