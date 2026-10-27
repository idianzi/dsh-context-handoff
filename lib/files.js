/**
 * Filesystem side of dsh-context-handoff: resolve the output directory, write
 * atomically, list/prune handoff files, and maintain the optional JSONL ledger.
 *
 * @module dsh-context-handoff/files
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const LEDGER_FILENAME = 'ledger.jsonl'

/**
 * Resolve `outputDir` against the session working directory.
 * @param {string} cwd - absolute session workspace.
 * @param {string} outputDir - relative or absolute configured directory.
 * @returns {string} absolute directory.
 */
export function resolveOutputDir(cwd, outputDir) {
  const base = cwd && path.isAbsolute(cwd) ? cwd : process.cwd()
  return path.isAbsolute(outputDir) ? path.normalize(outputDir) : path.resolve(base, outputDir)
}

/**
 * Display a path relative to the workspace when possible, using forward
 * slashes so the resume prompt works in Markdown.
 * @param {string} cwd
 * @param {string} absolute
 * @returns {string}
 */
export function displayPath(cwd, absolute) {
  const relative = path.relative(cwd, absolute)
  if (relative.length === 0) return path.basename(absolute)
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return relative.split(path.sep).join('/')
  return absolute.split(path.sep).join('/')
}

/** Build a collision-resistant filename. */
export function handoffFileName(sessionId, date = new Date()) {
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    '-',
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join('')
  const short = String(sessionId ?? 'session')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 8)
  return `${stamp}-${short || 'session'}-${randomUUID().slice(0, 4)}.md`
}

/**
 * Write a handoff atomically: temp file in the same directory, then rename.
 * @param {string} dir
 * @param {string} filename
 * @param {string} content
 * @returns {Promise<string>} absolute path.
 */
export async function writeHandoff(dir, filename, content) {
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, filename)
  const temporary = path.join(dir, `.${filename}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`)
  await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
  try {
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return target
}

/**
 * Read frontmatter from a handoff file. Returns undefined for files this plugin
 * did not write, so pruning never touches unrelated Markdown.
 * @param {string} absolute
 * @returns {Promise<object | undefined>}
 */
export async function readHandoffMeta(absolute) {
  let handle
  try {
    handle = await fs.open(absolute, 'r')
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const head = buffer.subarray(0, bytesRead).toString('utf8')
    const match = head.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (match === null) return undefined
    const fields = {}
    for (const line of match[1].split(/\r?\n/)) {
      const pair = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
      if (pair === null) continue
      fields[pair[1]] = parseScalar(pair[2])
    }
    if (fields.dsh_handoff !== 1) return undefined
    return fields
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

function parseScalar(raw) {
  const value = raw.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

/**
 * List handoff files newest first.
 * @param {string} dir
 * @returns {Promise<Array<{path: string, filename: string, mtimeMs: number, meta: object}>>}
 */
export async function listHandoffs(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const result = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const absolute = path.join(dir, entry.name)
    const meta = await readHandoffMeta(absolute)
    if (meta === undefined) continue
    let stat
    try {
      stat = await fs.stat(absolute)
    } catch {
      continue
    }
    result.push({ path: absolute, filename: entry.name, mtimeMs: stat.mtimeMs, meta })
  }
  result.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return result
}

/**
 * Return the newest handoff, if any.
 * @param {string} dir
 */
export async function latestHandoff(dir) {
  return (await listHandoffs(dir))[0]
}

/**
 * Delete the oldest handoff files beyond `keep`. Unrelated files are ignored.
 * @param {string} dir
 * @param {number} keep
 * @returns {Promise<string[]>} removed filenames.
 */
export async function pruneHandoffs(dir, keep) {
  if (!Number.isFinite(keep) || keep < 0) return []
  const files = await listHandoffs(dir)
  if (files.length <= keep) return []
  const removed = []
  for (const file of files.slice(keep)) {
    try {
      await fs.unlink(file.path)
      removed.push(file.filename)
    } catch {
      // A concurrent deletion or permission failure must not fail the handoff.
    }
  }
  return removed
}

/**
 * Append one JSON line to the ledger. Ledger failures never fail a handoff.
 * @param {string} dir
 * @param {object} record
 * @returns {Promise<boolean>} whether the record was appended.
 */
export async function appendLedger(dir, record) {
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.appendFile(path.join(dir, LEDGER_FILENAME), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * Read the most recent ledger records.
 * @param {string} dir
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function readLedger(dir, limit = 500) {
  let raw
  try {
    raw = await fs.readFile(path.join(dir, LEDGER_FILENAME), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    return []
  }
  const records = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    try {
      const value = JSON.parse(line)
      if (value !== null && typeof value === 'object') records.push(value)
    } catch {
      // Ignore a torn or hand-edited line; the rest of the ledger remains valid.
    }
  }
  return records.slice(-limit)
}
