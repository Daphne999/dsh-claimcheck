/**
 * Check execution and the evidence artifact.
 *
 * The artifact is the product. It is plain JSON, digest-addressed, pinned to
 * a workspace fingerprint, and written both to a per-workspace log and to the
 * session's evidence directory. Everything downstream (a reviewer, CI, another
 * plugin) can read it without this plugin being installed.
 *
 * @module dsh-claimcheck/evidence
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { runShell } from './fingerprint.js'

export const EVIDENCE_SCHEMA = 'dsh-claimcheck/evidence@1'
export const PLAN_SCHEMA = 'dsh-claimcheck/plan@1'

/** @typedef {import('./checks.js').Check} Check */

/**
 * Run a `file` check. Pure filesystem read; no shell involved.
 *
 * @param {Check} check
 * @param {string} cwd
 */
export async function runFileCheck(check, cwd) {
  const target = join(cwd, /** @type {string} */ (check.path).replace(/\\/g, '/'))
  let text = null
  try {
    text = await readFile(target, 'utf8')
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error).code
    return {
      status: 'fail',
      detail: code === 'ENOENT' ? `missing: ${check.path}` : `unreadable: ${code ?? 'unknown error'}`,
    }
  }
  if (check.contains === undefined) return { status: 'pass', detail: `present: ${check.path}` }
  if (check.regex === true) {
    let rx
    try { rx = new RegExp(/** @type {string} */ (check.contains)) } catch (error) {
      return { status: 'error', detail: `invalid regex at run time: ${error instanceof Error ? error.message : String(error)}` }
    }
    return rx.test(text)
      ? { status: 'pass', detail: `matched /${check.contains}/ in ${check.path}` }
      : { status: 'fail', detail: `did not match /${check.contains}/ in ${check.path}` }
  }
  return text.includes(/** @type {string} */ (check.contains))
    ? { status: 'pass', detail: `contained ${JSON.stringify(check.contains)} in ${check.path}` }
    : { status: 'fail', detail: `did not contain ${JSON.stringify(check.contains)} in ${check.path}` }
}

/**
 * Execute one check and return its raw result.
 *
 * @param {object} options
 * @param {Check} options.check
 * @param {string} options.cwd
 * @param {object} options.shell
 * @param {AbortSignal} [options.signal]
 */
export async function runCheck(options) {
  const { check, cwd, shell, signal } = options
  const startedAt = Date.now()
  if (check.kind === 'manual') {
    return {
      check,
      status: 'unknown',
      detail: `human attestation required: ${check.requirement ?? 'no requirement recorded'}`,
      durationMs: 0,
    }
  }
  if (check.kind === 'file') {
    const result = await runFileCheck(check, cwd)
    return { check, status: result.status, detail: result.detail, durationMs: Date.now() - startedAt }
  }

  const expect = check.expectExitCode ?? 0
  try {
    const result = await runShell(shell, /** @type {string} */ (check.command), {
      workdir: cwd,
      timeoutMs: check.timeoutMs,
      signal,
    })
    const exitCode = result.exitCode
    const timedOut = result.timedOut === true
    const status = timedOut ? 'error' : exitCode === expect ? 'pass' : 'fail'
    const output = `${result.stdout.text}${result.stderr.text.length > 0 ? `\n[stderr]\n${result.stderr.text}` : ''}`
    return {
      check,
      status,
      detail: timedOut
        ? `timed out after ${check.timeoutMs ?? 'configured'} ms`
        : `exit ${exitCode === null ? `signal ${result.signal ?? 'unknown'}` : exitCode}${expect !== 0 ? ` (expects ${expect})` : ''}`,
      exitCode,
      signal: result.signal ?? null,
      timedOut,
      output,
      outputDigest: digestOf(output),
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    return {
      check,
      status: 'error',
      detail: `could not run: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Date.now() - startedAt,
    }
  }
}

/**
 * Aggregate results into a verdict. A verdict of `pass` requires every
 * required check to have actually passed; anything unknown or error is
 * `incomplete`, never a pass.
 *
 * @param {Array<{ check: Check, status: string }>} results
 * @returns {'pass'|'fail'|'incomplete'}
 */
export function verdictOf(results) {
  if (results.length === 0) return 'incomplete'
  const required = results.filter(r => r.check.required)
  if (required.some(r => r.status === 'fail')) return 'fail'
  if (required.length === 0) return 'incomplete'
  if (required.every(r => r.status === 'pass')) return 'pass'
  return 'incomplete'
}

/**
 * Cap and shape a check result for the artifact.
 *
 * @param {{ check: Check, status: string, detail: string, exitCode?: number|null, signal?: string|null, timedOut?: boolean, output?: string, outputDigest?: string, durationMs: number }} result
 * @param {number} maxOutputBytes
 */
export function shapeResult(result, maxOutputBytes) {
  const raw = result.output ?? ''
  const truncated = Buffer.byteLength(raw, 'utf8') > maxOutputBytes
  const output = truncated
    ? Buffer.from(raw, 'utf8').subarray(0, maxOutputBytes).toString('utf8')
    : raw
  return {
    id: result.check.id,
    kind: result.check.kind,
    title: result.check.title,
    required: result.check.required,
    status: result.status,
    detail: result.detail,
    ...(result.check.kind === 'command' ? { command: result.check.command } : {}),
    ...(result.check.kind === 'file' ? { path: result.check.path } : {}),
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    timedOut: result.timedOut === true,
    outputDigest: result.outputDigest ?? digestOf(raw),
    outputBytes: Buffer.byteLength(raw, 'utf8'),
    outputTruncated: truncated,
    output,
    durationMs: result.durationMs,
  }
}

/** SHA-256 of a string, hex. @param {string} text */
export function digestOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** SHA-256 of the artifact's `digestless` payload, so the digest field itself is excluded. */
export function artifactDigest(artifact) {
  const { digest, ...rest } = artifact
  return digestOf(JSON.stringify(sortKeys(rest)))
}

/** Stable key order so digests do not depend on insertion order. @param {unknown} value */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(/** @type {Record<string, unknown>} */ (value)[key])
  return out
}

/**
 * Build the evidence artifact.
 *
 * @param {object} options
 * @param {object} options.plan
 * @param {Array<object>} options.results shaped results
 * @param {'pass'|'fail'|'incomplete'} options.verdict
 * @param {object} options.workspace { cwd, fingerprint }
 * @param {object} options.session { id, agentId, turn }
 * @param {number} options.startedAt
 * @param {number} options.finishedAt
 * @param {number} options.maxOutputBytes
 */
export function buildArtifact(options) {
  const counts = {
    total: options.results.length,
    pass: options.results.filter(r => r.status === 'pass').length,
    fail: options.results.filter(r => r.status === 'fail').length,
    unknown: options.results.filter(r => r.status === 'unknown').length,
    error: options.results.filter(r => r.status === 'error').length,
  }
  const artifact = {
    schema: EVIDENCE_SCHEMA,
    runId: `run-${options.startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date(options.startedAt).toISOString(),
    finishedAt: new Date(options.finishedAt).toISOString(),
    verdict: options.verdict,
    summary: summarize(options.verdict, counts),
    plugin: { name: 'dsh-claimcheck', version: options.version ?? '0.1.0' },
    session: {
      sessionId: options.session.id ?? null,
      agentId: options.session.agentId ?? null,
      turn: options.session.turn ?? null,
      cwd: options.workspace.cwd,
    },
    workspace: {
      fingerprint: options.workspace.fingerprint.digest,
      fingerprintSource: options.workspace.fingerprint.source,
      detail: options.workspace.fingerprint.detail,
    },
    plan: {
      id: options.plan.id,
      source: options.plan.source,
      checks: options.results.map(r => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        required: r.required,
        ...(r.command !== undefined ? { command: r.command } : {}),
        ...(r.path !== undefined ? { path: r.path } : {}),
      })),
    },
    counts,
    checks: options.results,
    digest: '',
  }
  artifact.digest = artifactDigest(artifact)
  return artifact
}

/** @param {'pass'|'fail'|'incomplete'} verdict @param {Record<string, number>} counts */
function summarize(verdict, counts) {
  if (verdict === 'pass') return `all ${counts.total} checks passed; required checks have evidence`
  if (verdict === 'fail') return `${counts.fail} of ${counts.total} checks failed; the claim is not supported`
  return `${counts.unknown + counts.error} of ${counts.total} checks produced no usable evidence; the claim is unproven`
}

/**
 * Persist an artifact atomically and append a one-line index entry.
 *
 * Layout under `<cwd>/.dsh/claimcheck/`:
 * - `runs/<runId>.json`   full artifact (atomically written)
 * - `latest.json`         copy of the newest artifact
 * - `index.jsonl`         append-only one-line summaries
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} options.evidenceDir relative directory under cwd
 * @param {object} options.artifact
 * @param {number} [options.retainRuns]
 * @returns {Promise<{ dir: string, runPath: string, latestPath: string, indexPath: string }>}
 */
export async function persistEvidence(options) {
  const dir = join(options.cwd, options.evidenceDir)
  const runsDir = join(dir, 'runs')
  await mkdir(runsDir, { recursive: true })
  const runPath = join(runsDir, `${options.artifact.runId}.json`)
  const latestPath = join(dir, 'latest.json')
  const indexPath = join(dir, 'index.jsonl')
  const body = `${JSON.stringify(options.artifact, null, 2)}\n`

  const tmp = `${runPath}.tmp-${process.pid}`
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, runPath)
  const latestTmp = `${latestPath}.tmp-${process.pid}`
  await writeFile(latestTmp, body, 'utf8')
  await rename(latestTmp, latestPath)

  const line = JSON.stringify({
    runId: options.artifact.runId,
    createdAt: options.artifact.createdAt,
    verdict: options.artifact.verdict,
    counts: options.artifact.counts,
    fingerprint: options.artifact.workspace.fingerprint,
    digest: options.artifact.digest,
  })
  await appendFile(indexPath, `${line}\n`, 'utf8')
  return { dir, runPath, latestPath, indexPath }
}

/**
 * Read the newest artifact from a working directory, or null.
 *
 * @param {string} cwd
 * @param {string} evidenceDir
 */
export async function readLatestEvidence(cwd, evidenceDir) {
  try {
    const text = await readFile(join(cwd, evidenceDir, 'latest.json'), 'utf8')
    const artifact = JSON.parse(text)
    if (artifact === null || typeof artifact !== 'object' || artifact.schema !== EVIDENCE_SCHEMA) return null
    return artifact
  } catch {
    return null
  }
}

/**
 * Is this artifact still valid for the current workspace fingerprint?
 *
 * @param {object|null} artifact
 * @param {{ digest: string }} current
 * @returns {{ fresh: boolean, reason: string }}
 */
export function freshnessOf(artifact, current) {
  if (artifact === null) return { fresh: false, reason: 'no evidence recorded yet' }
  if (artifact.workspace?.fingerprint !== current.digest) {
    return { fresh: false, reason: 'workspace changed since the checks ran; the evidence is stale' }
  }
  if (artifact.verdict !== 'pass') {
    return { fresh: false, reason: `the recorded verdict is ${artifact.verdict}, not pass` }
  }
  return { fresh: true, reason: 'evidence matches the current workspace' }
}

/** Ensure a directory exists (small helper kept here to avoid a utils module). */
export async function ensureDir(path) {
  await mkdir(dirname(path), { recursive: true })
}
