/**
 * Per-workspace auto-handoff switch.
 *
 * The switch belongs to the sidebar UI, so it must survive a restart without
 * rewriting the plugin's YAML config. Each workspace stores a tiny JSON file
 * next to its handoff output:
 *
 *   <workspace>/.dsh/handoff/auto.json  { "auto": true, "updatedAt": "..." }
 *
 * A missing file means "use the deployment default" (`config.auto`). The file
 * is only read/written by the host; it never enters the model context.
 *
 * @module dsh-context-handoff/auto-state
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveOutputDir } from './files.js'

export const AUTO_STATE_FILENAME = 'auto.json'

/**
 * Persisted per-workspace auto switch with an mtime cache.
 */
export class AutoStateStore {
  /**
   * @param {object} config - resolved plugin config.
   */
  constructor(config) {
    this.config = config
    /** @type {Map<string, {mtimeMs: number, auto: boolean, explicit: boolean}>} */
    this.cache = new Map()
  }

  /** Absolute path of the switch file for one workspace. */
  pathFor(cwd) {
    return path.join(resolveOutputDir(cwd, this.config.outputDir), AUTO_STATE_FILENAME)
  }

  /**
   * Read the switch. A missing or malformed file falls back to `config.auto`.
   * @param {string} cwd
   * @returns {Promise<{auto: boolean, explicit: boolean, path: string}>}
   */
  async read(cwd) {
    const file = this.pathFor(cwd)
    let stat
    try {
      stat = await fs.stat(file)
    } catch (error) {
      if (error.code === 'ENOENT') return { auto: this.config.auto, explicit: false, path: file }
      return { auto: this.config.auto, explicit: false, path: file }
    }
    const cached = this.cache.get(file)
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) return { ...cached, path: file }
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      const auto = parsed?.auto === true
      const record = { mtimeMs: stat.mtimeMs, auto, explicit: true }
      this.cache.set(file, record)
      return { ...record, path: file }
    } catch {
      return { auto: this.config.auto, explicit: false, path: file }
    }
  }

  /**
   * Persist an explicit switch. Atomic write in the same directory.
   * @param {string} cwd
   * @param {boolean} auto
   * @returns {Promise<void>}
   */
  async write(cwd, auto) {
    const file = this.pathFor(cwd)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    const body = `${JSON.stringify({ auto: Boolean(auto), updatedAt: new Date().toISOString() }, null, 2)}\n`
    await fs.writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
    try {
      await fs.rename(temporary, file)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    this.cache.delete(file)
  }
}
