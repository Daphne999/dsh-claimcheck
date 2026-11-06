/**
 * Workspace state fingerprints.
 *
 * A fingerprint answers one question: "is the working tree still the same
 * tree the checks ran against?" It is the only mechanism that lets evidence
 * expire on its own. Two sources:
 *
 * - git: `HEAD` revision plus `git status --porcelain=v1 -z` (tracked and
 *   untracked changes, deterministic ordering as git emits it);
 * - non-git: bounded recursive scan of regular files (path + size + mtime),
 *   capped so a huge tree cannot stall a turn.
 *
 * Fingerprints are cheap enough to take at turn boundaries and at every
 * status/verify call. They are *not* a security boundary: a determined local
 * process can rewrite content while preserving size and mtime. They are a
 * freshness signal, and the evidence artifact records them as such.
 *
 * @module dsh-claimcheck/fingerprint
 */
import { createHash } from 'node:crypto'
import { readdir, stat, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** Default cap for the non-git file scan. */
export const DEFAULT_SCAN_LIMIT = 5000

/** Directories never worth scanning for a freshness signal. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', '.next', 'target'])

/**
 * Paths ignored by default. Local data directories are not code: a memory
 * database that changes every turn must not expire evidence that a test run
 * proved. `.dsh` is already in SKIP_DIRS; `.dsh-meow` is the meow-memory store.
 */
export const DEFAULT_IGNORE_PATHS = ['.dsh-meow/']

/**
 * Normalize a configured ignore list into slash-separated prefixes. A trailing
 * slash is appended so a prefix cannot accidentally match a sibling directory
 * with the same leading characters.
 *
 * @param {unknown} input
 * @returns {string[]}
 */
export function normalizeIgnorePaths(input) {
  if (!Array.isArray(input)) return [...DEFAULT_IGNORE_PATHS]
  /** @type {string[]} */
  const normalized = []
  for (const item of input) {
    if (typeof item !== 'string') continue
    let path = item.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
    if (path.length === 0) continue
    if (!path.endsWith('/')) path += '/'
    normalized.push(path)
  }
  return normalized
}

/**
 * Is a workspace-relative path covered by one of the ignore prefixes?
 *
 * @param {string} relativePath
 * @param {string[]} ignorePaths already normalized (trailing slash)
 * @returns {boolean}
 */
export function isIgnoredPath(relativePath, ignorePaths) {
  if (ignorePaths.length === 0) return false
  const path = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  return ignorePaths.some(prefix => path === prefix.slice(0, -1) || path.startsWith(prefix))
}

/**
 * Run one shell command through the harness shell seam and collect it.
 *
 * @param {{ resolve: (req: object) => object, execute: (spec: object) => Promise<{ result: () => Promise<ShellResult> }> }} shell
 * @param {string} command
 * @param {{ workdir: string, timeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<ShellResult>}
 */
export async function runShell(shell, command, options) {
  const request = { command, workdir: options.workdir }
  if (options.timeoutMs !== undefined) request.timeoutMs = options.timeoutMs
  if (options.signal !== undefined) request.signal = options.signal
  const execution = await shell.execute(shell.resolve(request))
  return execution.result()
}

/** @typedef {{ exitCode: number|null, signal?: string|null, timedOut?: boolean, stdout: { text: string }, stderr: { text: string } }} ShellResult */

/**
 * Detect repository identity once per call site.
 *
 * @param {{ shell: object, cwd: string, timeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<{ isRepo: boolean, head: string|null, branch: string|null }>}
 */
export async function gitIdentity(options) {
  const { shell, cwd, timeoutMs = 20_000, signal } = options
  try {
    const inside = await runShell(shell, 'git rev-parse --is-inside-work-tree', { workdir: cwd, timeoutMs, signal })
    if (inside.exitCode !== 0 || inside.stdout.text.trim() !== 'true') return { isRepo: false, head: null, branch: null }
    const [headResult, branchResult] = await Promise.all([
      runShell(shell, 'git rev-parse HEAD', { workdir: cwd, timeoutMs, signal }),
      runShell(shell, 'git rev-parse --abbrev-ref HEAD', { workdir: cwd, timeoutMs, signal }),
    ])
    return {
      isRepo: true,
      head: headResult.exitCode === 0 ? headResult.stdout.text.trim() || null : null,
      branch: branchResult.exitCode === 0 ? branchResult.stdout.text.trim() || null : null,
    }
  } catch {
    return { isRepo: false, head: null, branch: null }
  }
}

/**
 * Take a workspace fingerprint.
 *
 * @param {object} options
 * @param {object} options.shell
 * @param {string} options.cwd
 * @param {number} [options.scanLimit]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {string[]} [options.ignorePaths] workspace-relative prefixes to ignore
 * @returns {Promise<{ source: 'git'|'files', digest: string, detail: object }>}
 */
export async function fingerprint(options) {
  const ignorePaths = normalizeIgnorePaths(options.ignorePaths)
  const identity = await gitIdentity(options)
  if (identity.isRepo) {
    const status = await runShell(options.shell, 'git status --porcelain=v1 -z --untracked-files=normal', {
      workdir: options.cwd,
      timeoutMs: options.timeoutMs ?? 20_000,
      signal: options.signal,
    })
    if (status.exitCode === 0) {
      const rawEntries = status.stdout.text.split('\u0000').filter(part => part.length > 0)
      // `git status -z` entries are `XY path`; rename entries are followed by
      // the original path as a bare entry. Check both shapes against the
      // ignore prefixes, then hash what is left.
      const entries = rawEntries.filter((entry) => {
        const pathInEntry = entry.length > 3 ? entry.slice(3) : entry
        return !isIgnoredPath(pathInEntry, ignorePaths) && !isIgnoredPath(entry, ignorePaths)
      })
      const digest = createHash('sha256')
        .update('git\u0000')
        .update(identity.head ?? '')
        .update('\u0000')
        .update(entries.join('\u0000'))
        .digest('hex')
      return {
        source: 'git',
        digest,
        detail: { head: identity.head, branch: identity.branch, dirtyFiles: entries.length, ignoredPaths: ignorePaths },
      }
    }
  }
  return fileFingerprint({ ...options, ignorePaths })
}

/**
 * Fallback fingerprint for non-git directories: sorted path+size+mtime lines
 * over a bounded scan.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {number} [options.scanLimit]
 * @param {AbortSignal} [options.signal]
 * @param {string[]} [options.ignorePaths]
 * @returns {Promise<{ source: 'files', digest: string, detail: { scanned: number, truncated: boolean } }>}
 */
export async function fileFingerprint(options) {
  const limit = options.scanLimit ?? DEFAULT_SCAN_LIMIT
  const ignorePaths = normalizeIgnorePaths(options.ignorePaths)
  /** @type {string[]} */
  const lines = []
  let truncated = false

  /**
   * @param {string} dir
   * @param {number} depth
   */
  async function walk(dir, depth) {
    if (lines.length >= limit) { truncated = true; return }
    if (depth > 12) { truncated = true; return }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (options.signal?.aborted) return
      if (lines.length >= limit) { truncated = true; return }
      const path = join(dir, entry.name)
      const relativePath = relative(options.cwd, path).replace(/\\/g, '/')
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (isIgnoredPath(`${relativePath}/`, ignorePaths)) continue
        await walk(path, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (isIgnoredPath(relativePath, ignorePaths)) continue
      try {
        const info = await stat(path)
        lines.push(`${path}\u0001${info.size}\u0001${Math.trunc(info.mtimeMs)}`)
      } catch {
        // A file that vanished mid-scan contributes nothing; the next
        // fingerprint will differ, which is exactly the desired signal.
      }
    }
  }

  await walk(options.cwd, 0)
  const digest = createHash('sha256').update('files\u0000').update(lines.join('\n')).digest('hex')
  return { source: 'files', digest, detail: { scanned: lines.length, truncated, ignoredPaths: ignorePaths } }
}

/**
 * Read a file as UTF-8, returning null when it is absent or unreadable.
 * @param {string} path
 * @returns {Promise<string|null>}
 */
export async function readTextFile(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}
