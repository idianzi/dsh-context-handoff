import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  appendLedger,
  displayPath,
  handoffFileName,
  latestHandoff,
  listHandoffs,
  pruneHandoffs,
  readHandoffMeta,
  readLedger,
  resolveOutputDir,
  writeHandoff,
} from '../lib/files.js'

test('files: write, read, list, prune, and ledger', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-files-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = resolveOutputDir(root, '.dsh/handoff')
  assert.equal(dir, path.join(root, '.dsh/handoff'))

  const oldDate = new Date('2026-01-01T00:00:00Z')
  const a = handoffFileName('sess-1', oldDate)
  const b = handoffFileName('sess-2', new Date('2026-01-02T00:00:00Z'))
  assert.match(a, /^20260101-/)
  assert.notEqual(a, b)

  const content = `---\ndsh_handoff: 1\nsession: "sess-1"\ndigest_tokens: 12\n---\n# Handoff\n`
  const absolute = await writeHandoff(dir, a, content)
  assert.equal(await readFile(absolute, 'utf8'), content)
  const meta = await readHandoffMeta(absolute)
  assert.equal(meta.session, 'sess-1')
  assert.equal(meta.digest_tokens, 12)

  await writeHandoff(dir, b, content.replace('sess-1', 'sess-2'))
  const listed = await listHandoffs(dir)
  assert.equal(listed.length, 2)
  assert.equal((await latestHandoff(dir)).filename, b)

  // A file without the marker is never listed or pruned.
  await writeHandoff(dir, 'notes.md', '# unrelated\n')
  assert.equal((await listHandoffs(dir)).length, 2)
  const removed = await pruneHandoffs(dir, 1)
  assert.equal(removed.length, 1)
  assert.equal((await listHandoffs(dir)).length, 1)
  assert.equal(await readFile(path.join(dir, 'notes.md'), 'utf8'), '# unrelated\n')

  await appendLedger(dir, { v: 1, source_tokens: 100 })
  await appendLedger(dir, { v: 1, source_tokens: 200 })
  assert.deepEqual(await readLedger(dir), [{ v: 1, source_tokens: 100 }, { v: 1, source_tokens: 200 }])
})

test('files: displayPath stays relative inside the workspace', () => {
  assert.equal(displayPath('/work', '/work/.dsh/handoff/x.md'), '.dsh/handoff/x.md')
  assert.equal(displayPath('/work', '/other/x.md'), '/other/x.md')
})
