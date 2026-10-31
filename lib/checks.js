/**
 * Check planning: validation, red-line screening, and auto-discovery.
 *
 * A "check" is one thing that must be demonstrably true. Two are executable
 * by the plugin itself (`command`, `file`); one is explicitly a human
 * attestation and never counts as a pass on its own.
 *
 * @module dsh-claimcheck/checks
 */
import { join } from 'node:path'
import { readTextFile } from './fingerprint.js'

/** @typedef {{ id: string, kind: 'command'|'file'|'manual', title: string, command?: string, timeoutMs?: number, expectExitCode?: number, path?: string, contains?: string, regex?: boolean, requirement?: string, required: boolean }} Check */

/** Hard caps so a plan cannot become a denial-of-service on itself. */
export const MAX_CHECKS = 12
export const MAX_COMMAND_LENGTH = 4000
export const MIN_TIMEOUT_MS = 1000
export const MAX_TIMEOUT_MS = 900_000
export const DEFAULT_TIMEOUT_MS = 180_000

/**
 * Commands this plugin refuses to run as a "check", regardless of who asked.
 * These are not the only dangerous commands in the world; they are the ones
 * where a verification gate would be actively lying about what it is doing.
 * Callers can add more with `denyCommands`, never fewer.
 */
const RED_LINE_PATTERNS = [
  { id: 'recursive-force-delete', rx: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\$HOME|\.\s*$|[A-Za-z]:\\)/i },
  { id: 'windows-recursive-delete', rx: /\bRemove-Item\b[^\n]*\s-(?:Recurse|Force)\b[^\n]*[A-Za-z]:\\(?!.*\\[^\\]+\\)/i },
  { id: 'disk-format', rx: /\b(format|mkfs(\.\w+)?|diskpart)\b/i },
  { id: 'shutdown', rx: /\b(shutdown|reboot|halt|poweroff)\b/i },
  { id: 'pipe-to-shell', rx: /(\bcurl\b|\bwget\b|\biwr\b)[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i },
  { id: 'fork-bomb', rx: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { id: 'chmod-world', rx: /\bchmod\s+-R\s+777\s+\//i },
  { id: 'git-history-rewrite', rx: /\bgit\s+(push\s+--force|push\s+-f|reset\s+--hard\s+HEAD~?\d*\s*$|clean\s+-[a-zA-Z]*f[a-zA-Z]*d)/i },
  { id: 'credential-upload', rx: /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*(\.ssh|\.aws|\.credentials|id_rsa|\.env\b)/i },
]

/**
 * Normalize and validate one incoming check.
 *
 * @param {unknown} raw
 * @param {number} index
 * @returns {{ ok: true, check: Check } | { ok: false, id: string, reason: string }}
 */
export function normalizeCheck(raw, index) {
  const fallbackId = `check-${index + 1}`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, id: fallbackId, reason: 'each check must be an object' }
  }
  const input = /** @type {Record<string, unknown>} */ (raw)
  const id = typeof input.id === 'string' && input.id.trim().length > 0 ? input.id.trim().slice(0, 80) : fallbackId
  const kind = input.kind
  if (kind !== 'command' && kind !== 'file' && kind !== 'manual') {
    return { ok: false, id, reason: "kind must be 'command', 'file' or 'manual'" }
  }
  const title = typeof input.title === 'string' && input.title.trim().length > 0
    ? input.title.trim().slice(0, 300)
    : undefined
  if (title === undefined) return { ok: false, id, reason: 'title is required (what must be true, in one line)' }
  const required = input.required !== false

  if (kind === 'command') {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (command.length === 0) return { ok: false, id, reason: 'command checks need a command' }
    if (command.length > MAX_COMMAND_LENGTH) return { ok: false, id, reason: `command exceeds ${MAX_COMMAND_LENGTH} characters` }
    const hit = screenCommand(command)
    if (hit !== null) return { ok: false, id, reason: `command refused by safety screen (${hit})` }
    const timeoutMs = clampTimeout(input.timeoutMs)
    const expectExitCode = Number.isInteger(input.expectExitCode) ? /** @type {number} */ (input.expectExitCode) : 0
    return { ok: true, check: { id, kind, title, command, timeoutMs, expectExitCode, required } }
  }

  if (kind === 'file') {
    const path = typeof input.path === 'string' ? input.path.trim() : ''
    if (path.length === 0) return { ok: false, id, reason: 'file checks need a path (relative to the working directory)' }
    if (isEscapingPath(path)) return { ok: false, id, reason: 'path must stay inside the working directory' }
    const contains = typeof input.contains === 'string' && input.contains.length > 0 ? input.contains : undefined
    const regex = input.regex === true
    if (regex && contains !== undefined) {
      try { new RegExp(contains) } catch (error) { return { ok: false, id, reason: `invalid regex: ${error instanceof Error ? error.message : String(error)}` } }
    }
    return { ok: true, check: { id, kind, title, path, contains, regex, required } }
  }

  const requirement = typeof input.requirement === 'string' && input.requirement.trim().length > 0
    ? input.requirement.trim().slice(0, 500)
    : 'requires human attestation'
  return { ok: true, check: { id, kind, title, requirement, required } }
}

/**
 * Screen a command against the red lines.
 * @param {string} command
 * @returns {string|null} matched rule id, or null when acceptable
 */
export function screenCommand(command) {
  for (const rule of RED_LINE_PATTERNS) {
    if (rule.rx.test(command)) return rule.id
  }
  return null
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function clampTimeout(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(value)))
}

/**
 * Reject absolute paths and traversal so a check artifact cannot smuggle a
 * read outside the workspace.
 * @param {string} path
 */
export function isEscapingPath(path) {
  const normalized = path.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return true
  if (/^[A-Za-z]:\//.test(normalized)) return true
  return normalized.split('/').some(segment => segment === '..')
}

/**
 * Auto-discover plausible verification commands for the working directory.
 * Discovery is intentionally conservative: only well-known project shapes and
 * only a canonical command per shape.
 *
 * @param {string} cwd
 * @returns {Promise<Check[]>}
 */
export async function discoverChecks(cwd) {
  /** @type {Check[]} */
  const checks = []
  const push = (check) => { if (checks.length < MAX_CHECKS) checks.push(check) }

  const pkgText = await readTextFile(join(cwd, 'package.json'))
  if (pkgText !== null) {
    let pkg = null
    try { pkg = JSON.parse(pkgText) } catch { pkg = null }
    if (pkg !== null && typeof pkg === 'object') {
      const scripts = (pkg.scripts ?? {})
      const runner = await detectNodeRunner(cwd)
      for (const name of ['test', 'typecheck', 'lint', 'build']) {
        const script = scripts[name]
        if (typeof script !== 'string' || script.trim().length === 0) continue
        push({
          id: `npm-${name}`,
          kind: 'command',
          title: `\`${runner} run ${name}\` exits 0`,
          command: `${runner} run ${name}`,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          expectExitCode: 0,
          required: name !== 'build',
        })
      }
    }
  }

  if (checks.length === 0) {
    if (await exists(join(cwd, 'pytest.ini')) || await exists(join(cwd, 'conftest.py')) || await hasSection(await readTextFile(join(cwd, 'pyproject.toml')), '[tool.pytest')) {
      push({ id: 'pytest', kind: 'command', title: 'pytest exits 0', command: 'python -m pytest -q', timeoutMs: 300_000, expectExitCode: 0, required: true })
    }
    if (await exists(join(cwd, 'Cargo.toml'))) {
      push({ id: 'cargo-test', kind: 'command', title: 'cargo test exits 0', command: 'cargo test --quiet', timeoutMs: 600_000, expectExitCode: 0, required: true })
    }
    if (await exists(join(cwd, 'go.mod'))) {
      push({ id: 'go-test', kind: 'command', title: 'go test ./... exits 0', command: 'go test ./...', timeoutMs: 600_000, expectExitCode: 0, required: true })
    }
  }
  return checks
}

/**
 * Pick the node package manager by lockfile presence.
 * @param {string} cwd
 */
async function detectNodeRunner(cwd) {
  if (await exists(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await exists(join(cwd, 'yarn.lock'))) return 'yarn'
  if (await exists(join(cwd, 'bun.lockb'))) return 'bun'
  return 'npm'
}

/**
 * @param {string} path
 */
async function exists(path) {
  return (await readTextFile(path)) !== null
}

/**
 * @param {string|null} text
 * @param {string} section
 */
function hasSection(text, section) {
  return text !== null && text.includes(section)
}
