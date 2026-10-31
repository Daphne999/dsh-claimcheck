/**
 * dsh-claimcheck — evidence-backed completion for DeepSeek Harness.
 *
 * The model-facing contract is three verbs:
 *
 * - `claim_plan`   declare what must be true;
 * - `claim_verify` run the checks HERE (the plugin executes them), pin the
 *                  results to the current workspace fingerprint, and write a
 *                  digest-addressed evidence artifact;
 * - `claim_status` ask whether the recorded evidence still matches the tree.
 *
 * Plus a turn-completion gate: when a turn ends after file-mutating work with
 * no fresh passing evidence, the plugin keeps the turn open and tells the
 * agent what proof is missing. `warn` mode (default) also only nudges, but
 * with a bounded budget and explicit text; `strict` mode is the same
 * mechanism with the intent to hold the turn open until evidence lands.
 *
 * Zero runtime `@deepseek-ai/*` imports — see lib/schema.js for why.
 *
 * @module dsh-claimcheck
 */
import { join } from 'node:path'
import { defineTool } from './schema.js'
import { fingerprint } from './fingerprint.js'
import { discoverChecks, normalizeCheck, MAX_CHECKS } from './checks.js'
import {
  buildArtifact,
  freshnessOf,
  persistEvidence,
  readLatestEvidence,
  runCheck,
  shapeResult,
  verdictOf,
} from './evidence.js'

export const name = 'dsh-claimcheck'

/** Required services: the shell seam to run checks, the registry for tools. */
export const inject = ['shell', 'tools']

/**
 * Supported `config` keys (validated defensively in `apply`; no schema export
 * so activation never depends on a config-schema peer):
 *
 * - mode: 'warn' | 'strict' | 'off'   (default 'warn')
 * - maxNudgesPerSession: number        (default 3)
 * - commandTimeoutMs: number           (default 180_000)
 * - maxOutputBytes: number             (default 16_384)
 * - evidenceDir: string                (default '.dsh/claimcheck')
 * - autoDiscover: boolean              (default true)
 * - requireGateAfterWrite: boolean     (default true)
 */

/** @param {any} value @param {number} fallback */
const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/**
 * Mount the plugin.
 *
 * @param {any} ctx Cordis context with `shell` and `tools` injected.
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const settings = {
    mode: config.mode === 'strict' || config.mode === 'off' ? config.mode : 'warn',
    maxNudgesPerSession: num(config.maxNudgesPerSession, 3),
    commandTimeoutMs: num(config.commandTimeoutMs, 180_000),
    maxOutputBytes: num(config.maxOutputBytes, 16_384),
    evidenceDir: typeof config.evidenceDir === 'string' && config.evidenceDir.length > 0 ? config.evidenceDir : '.dsh/claimcheck',
    autoDiscover: config.autoDiscover !== false,
    requireGateAfterWrite: config.requireGateAfterWrite !== false,
  }

  /** @type {Map<string, { nudges: number, mutatedThisTurn: boolean, plannedAt: number|null, lastArtifact: any }>} */
  const sessions = new Map()
  /** Per-cwd plan cache so `claim_plan` survives without a storage service. */
  /** @type {Map<string, any>} */
  const plans = new Map()

  /**
   * @param {any} state
   * @returns {{ nudges: number, mutatedThisTurn: boolean, plannedAt: number|null, lastArtifact: any }}
   */
  const stateOf = (state) => {
    if (state === undefined || state === null) return { nudges: 0, mutatedThisTurn: false, plannedAt: null, lastArtifact: null }
    return state
  }

  /** @param {unknown} exec */
  const sessionOf = (exec) => {
    const agent = /** @type {{ id?: string, session?: { id?: string, header?: { cwd?: string } } }} */ (exec && /** @type {any} */ (exec).agent)
    const cwd = agent?.session?.header?.cwd
    const sessionId = agent?.session?.id ?? agent?.id ?? 'unknown'
    return { agent, cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd(), sessionId }
  }

  /** @param {string} cwd @param {AbortSignal} [signal] */
  const currentFingerprint = async (cwd, signal) => fingerprint({ shell: ctx.shell, cwd, signal })

  // ---------------------------------------------------------------- tools
  const planTool = defineTool({
    name: 'claim_plan',
    description:
      'Declare what must be demonstrably true before work counts as complete here. '
      + 'Call this before finishing non-trivial work, then call claim_verify. '
      + 'A check is one of: kind=command (the plugin runs it and requires the expected exit code), '
      + 'kind=file (the plugin verifies a path exists / contains text), kind=manual (explicitly requires a human). '
      + 'If you do not know what to check, omit checks and call claim_verify, which auto-discovers the project test commands.',
    parameters: {
      checks: {
        type: 'array',
        description: 'Checks to record. Maximum 12.',
        items: { type: 'json' },
      },
      source: {
        type: 'string',
        description: "Who chose these checks: 'agent' (default) or 'user'.",
        enum: ['agent', 'user'],
      },
    },
    render: (_args, value) => {
      const v = /** @type {any} */ (value)
      return [{ type: 'text', text: `验收计划已记录：${v.checks.length} 条（${v.planId}）\n${v.lines.join('\n')}\n下一步：调用 claim_verify 真正执行这些检查。` }]
    },
    async execute(args, exec) {
      const a = /** @type {{ checks?: unknown[], source?: string }} */ (args)
      const { cwd, sessionId } = sessionOf(exec)
      const raw = Array.isArray(a.checks) ? a.checks : []
      if (raw.length > MAX_CHECKS) throw new Error(`Error: at most ${MAX_CHECKS} checks are allowed`)
      /** @type {any[]} */
      const checks = []
      /** @type {string[]} */
      const rejected = []
      raw.forEach((item, index) => {
        const normalized = normalizeCheck(item, index)
        if (normalized.ok) checks.push(normalized.check)
        else rejected.push(`${normalized.id}: ${normalized.reason}`)
      })
      if (rejected.length > 0) throw new Error(`Error: rejected checks — ${rejected.join('; ')}`)
      if (checks.length === 0) throw new Error('Error: at least one check is required; omit `checks` on claim_verify to auto-discover')
      const planId = `plan-${Date.now().toString(36)}`
      plans.set(cwd, { id: planId, source: a.source === 'user' ? 'user' : 'agent', checks, createdAt: Date.now() })
      const st = stateOf(sessions.get(sessionId))
      st.plannedAt = Date.now()
      sessions.set(sessionId, st)
      return {
        planId,
        checks,
        lines: checks.map((c, i) => `${i + 1}. [${c.kind}${c.required ? '' : ', optional'}] ${c.title}${c.command ? ` — \`${c.command}\`` : ''}${c.path ? ` — ${c.path}` : ''}`),
      }
    },
  })

  const verifyTool = defineTool({
    name: 'claim_verify',
    description:
      'Run the completion checks for this working directory and record evidence. '
      + 'The plugin executes the commands itself, captures exit codes and bounded output, pins the run to the current '
      + 'working-tree fingerprint, writes an artifact under the evidence directory, and returns a verdict. '
      + 'Verdict pass requires every required check to have actually passed; a missing check is never a pass. '
      + 'Call this before telling the user work is done. If it returns fail or incomplete, fix the cause and call it again. '
      + 'If you have no plan, omit checks: the plugin auto-discovers the project test command.',
    parameters: {
      checks: {
        type: 'array',
        description: 'Override the recorded plan with these checks (same shape as claim_plan).',
        items: { type: 'json' },
      },
      planId: { type: 'string', description: 'Plan id returned by claim_plan; optional, the latest plan for this directory is used.' },
    },
    render: (_args, value) => {
      const v = /** @type {any} */ (value)
      const icon = v.verdict === 'pass' ? '✅' : v.verdict === 'fail' ? '❌' : '⚠️'
      return [{ type: 'text', text: `${icon} 验收结论：${v.verdict}（${v.counts.pass}/${v.counts.total} 通过）\n${v.lines.join('\n')}\n证据：${v.artifactPath}\ndigest：${v.digest}` }]
    },
    async execute(args, exec) {
      const a = /** @type {{ checks?: unknown[], planId?: string }} */ (args)
      const { cwd, sessionId, agent } = sessionOf(exec)
      const signal = /** @type {any} */ (exec)?.signal
      let plan = plans.get(cwd)
      if (Array.isArray(a.checks) && a.checks.length > 0) {
        if (a.checks.length > MAX_CHECKS) throw new Error(`Error: at most ${MAX_CHECKS} checks are allowed`)
        /** @type {any[]} */
        const checks = []
        /** @type {string[]} */
        const rejected = []
        a.checks.forEach((item, index) => {
          const normalized = normalizeCheck(item, index)
          if (normalized.ok) checks.push(normalized.check)
          else rejected.push(`${normalized.id}: ${normalized.reason}`)
        })
        if (rejected.length > 0) throw new Error(`Error: rejected checks — ${rejected.join('; ')}`)
        plan = { id: a.planId ?? `plan-${Date.now().toString(36)}`, source: 'agent', checks, createdAt: Date.now() }
        plans.set(cwd, plan)
      }
      if (plan === undefined && settings.autoDiscover) {
        const discovered = await discoverChecks(cwd)
        if (discovered.length > 0) {
          plan = { id: `discovered-${Date.now().toString(36)}`, source: 'discovered', checks: discovered, createdAt: Date.now() }
          plans.set(cwd, plan)
        }
      }
      if (plan === undefined) {
        throw new Error(
          'Error: no plan and no discoverable checks. Pass `checks` to claim_verify describing how to prove the work '
          + '(for example a command that runs the relevant tests and exits 0).',
        )
      }

      const startedAt = Date.now()
      const before = await currentFingerprint(cwd, signal)
      /** @type {any[]} */
      const results = []
      for (const check of plan.checks) {
        if (signal?.aborted) break
        results.push(await runCheck({ check, cwd, shell: ctx.shell, signal }))
      }
      const after = await currentFingerprint(cwd, signal)
      const mutatedDuringRun = after.digest !== before.digest
      const verdict = mutatedDuringRun ? 'incomplete' : verdictOf(results)
      const shaped = results.map(result => shapeResult(result, settings.maxOutputBytes))
      const artifact = buildArtifact({
        plan,
        results: shaped,
        verdict,
        workspace: { cwd, fingerprint: after },
        session: { id: sessionId, agentId: agent?.id ?? null, turn: null },
        startedAt,
        finishedAt: Date.now(),
        version: '0.1.0',
      })
      const paths = await persistEvidence({ cwd, evidenceDir: settings.evidenceDir, artifact })
      const st = stateOf(sessions.get(sessionId))
      st.lastArtifact = artifact
      st.mutatedThisTurn = false
      sessions.set(sessionId, st)
      return renderVerification(artifact, shaped, paths.runPath, mutatedDuringRun)
    },
  })

  const statusTool = defineTool({
    name: 'claim_status',
    description:
      'Report whether the recorded completion evidence is still fresh, stale, failing, or missing for this working directory. '
      + 'Fresh means: the checks passed AND the working tree has not changed since they ran. '
      + 'Read-only — it never runs checks and never writes evidence.',
    parameters: {},
    render: (_args, value) => {
      const v = /** @type {any} */ (value)
      const icon = v.fresh ? '✅' : v.verdict === 'none' ? '○' : '⚠️'
      return [{ type: 'text', text: `${icon} ${v.headline}${v.artifactPath ? `\n证据：${v.artifactPath}` : ''}` }]
    },
    async execute(_args, exec) {
      const { cwd } = sessionOf(exec)
      const signal = /** @type {any} */ (exec)?.signal
      const artifact = await readLatestEvidence(cwd, settings.evidenceDir)
      const current = await currentFingerprint(cwd, signal)
      if (artifact === null) {
        return {
          verdict: 'none',
          fresh: false,
          headline: `当前工作区还没有任何验收证据（fingerprint ${current.digest.slice(0, 12)}）；工作完成前调用 claim_verify。`,
          fingerprint: current.digest,
          artifactPath: null,
          checks: [],
        }
      }
      const fresh = freshnessOf(artifact, current)
      return {
        verdict: artifact.verdict,
        fresh: fresh.fresh,
        headline: fresh.fresh
          ? `证据有效：${artifact.counts.pass}/${artifact.counts.total} 通过，且工作区自记录以来未变化。`
          : `证据不可用：${fresh.reason}。`,
        reason: fresh.reason,
        fingerprint: current.digest,
        recordedFingerprint: artifact.workspace?.fingerprint ?? null,
        artifactPath: join(cwd, settings.evidenceDir, 'runs', `${artifact.runId}.json`),
        digest: artifact.digest,
        createdAt: artifact.createdAt,
        counts: artifact.counts,
        checks: artifact.checks.map(c => ({ id: c.id, title: c.title, status: c.status, detail: c.detail })),
      }
    },
  })

  const reportTool = defineTool({
    name: 'claim_report',
    description: 'Render the latest evidence artifact as a Markdown section for a handoff, review request, or commit message.',
    parameters: {},
    render: (_args, value) => [{ type: 'text', text: /** @type {any} */ (value).markdown }],
    async execute(_args, exec) {
      const { cwd } = sessionOf(exec)
      const artifact = await readLatestEvidence(cwd, settings.evidenceDir)
      if (artifact === null) throw new Error('Error: no evidence recorded yet; run claim_verify first')
      const md = renderMarkdown(artifact)
      return { markdown: md, digest: artifact.digest }
    },
  })

  for (const tool of [planTool, verifyTool, statusTool, reportTool]) {
    ctx.tools.register(tool)
  }

  // ------------------------------------------------------- completion gate
  /**
   * Decide whether a turn that is about to close deserves to close.
   *
   * @param {string} cwd
   * @param {{ mutatedThisTurn: boolean }} state
   */
  async function gateDecision(cwd, state) {
    if (settings.mode === 'off') return { shouldNudge: false, reason: 'gate disabled' }
    if (settings.requireGateAfterWrite && !state.mutatedThisTurn) return { shouldNudge: false, reason: 'no file-mutating work in this turn' }
    const artifact = await readLatestEvidence(cwd, settings.evidenceDir)
    let current
    try {
      current = await currentFingerprint(cwd)
    } catch (error) {
      return { shouldNudge: false, reason: `fingerprint unavailable: ${error instanceof Error ? error.message : String(error)}` }
    }
    const fresh = freshnessOf(artifact, current)
    if (fresh.fresh) return { shouldNudge: false, reason: fresh.reason, fresh: true }
    return { shouldNudge: true, reason: fresh.reason, artifact, current }
  }

  /**
   * Install the gate on one agent's scoped context.
   * @param {any} agent
   */
  function attachToAgent(agent) {
    const sessionId = agent?.session?.id ?? agent?.id
    if (typeof sessionId !== 'string') return
    if (!sessions.has(sessionId)) sessions.set(sessionId, { nudges: 0, mutatedThisTurn: false, plannedAt: null, lastArtifact: null })
    const scoped = agent?.ctx ?? ctx

    // Track which mutating tools ran this turn. `tools/result` is observe-only
    // and fires for every settled call on this agent.
    const disposeResult = scoped.on('tools/result', (payload) => {
      try {
        const toolName = payload?.name ?? payload?.tool?.name ?? payload?.call?.name
        if (typeof toolName !== 'string') return
        const mutation = isMutatingTool(toolName, payload)
        if (mutation) {
          const st = stateOf(sessions.get(sessionId))
          st.mutatedThisTurn = true
          sessions.set(sessionId, st)
        }
      } catch {
        // A malformed payload must never break the tool pipeline.
      }
    })

    const disposeStop = scoped.on('agent/turn-stopping', async () => {
      const st = stateOf(sessions.get(sessionId))
      if (settings.mode === 'off') return
      if (st.nudges >= settings.maxNudgesPerSession) return
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || cwd.length === 0) return
      const decision = await gateDecision(cwd, st)
      if (!decision.shouldNudge) return
      st.nudges += 1
      st.mutatedThisTurn = false
      sessions.set(sessionId, st)
      const text = nudgeText(decision.reason, st.nudges, settings.mode, settings.evidenceDir)
      try {
        await agent.followup({
          content: [{ type: 'text', text }],
          source: { kind: 'dsh-claimcheck' },
        })
      } catch {
        // If the followup cannot be queued the turn simply ends un-gated; the
        // artifact and claim_status still tell the truth.
      }
    })

    ctx.effect(() => () => {
      try { disposeResult() } catch { /* already disposed */ }
      try { disposeStop() } catch { /* already disposed */ }
    }, `dsh-claimcheck: agent ${sessionId}`)
  }

  if (typeof ctx.on === 'function') {
    try {
      ctx.on('agent/created', (payload) => {
        const agent = payload?.agent ?? payload
        try { attachToAgent(agent) } catch { /* never break agent creation */ }
      })
    } catch {
      // Profiles without the agents service simply have no gate.
    }
  }
}

// --------------------------------------------------------------- rendering

/**
 * @param {any} artifact
 * @param {any[]} shaped
 * @param {string} artifactPath
 * @param {boolean} mutatedDuringRun
 */
function renderVerification(artifact, shaped, artifactPath, mutatedDuringRun) {
  const lines = shaped.map((r) => {
    const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : r.status === 'unknown' ? '?' : '!'
    const head = `${mark} ${r.id}: ${r.title}`
    const detail = r.detail.length > 0 ? ` — ${r.detail}` : ''
    const tail = r.status === 'fail' && r.output.length > 0
      ? `\n    ${firstMeaningfulLine(r.output).slice(0, 400)}`
      : ''
    return `${head}${detail}${tail}`
  })
  if (mutatedDuringRun) {
    lines.push('! the working tree changed while the checks were running; this run cannot be a pass — re-run claim_verify')
  }
  return {
    verdict: artifact.verdict,
    counts: artifact.counts,
    digest: artifact.digest,
    fingerprint: artifact.workspace.fingerprint,
    artifactPath,
    runId: artifact.runId,
    lines,
  }
}

/** @param {string} output */
function firstMeaningfulLine(output) {
  const line = output.split(/\r?\n/).find(l => l.trim().length > 0) ?? ''
  return line.trim()
}

/**
 * Should this settled tool call count as "the agent changed something"?
 * @param {string} toolName
 * @param {any} payload
 */
export function isMutatingTool(toolName, payload) {
  if (toolName === 'write' || toolName === 'edit' || toolName === 'str_replace_editor') return true
  if (toolName !== 'bash' && toolName !== 'pwsh') return false
  const args = payload?.arguments ?? payload?.call?.arguments ?? {}
  const command = typeof args?.command === 'string' ? args.command : ''
  if (command.length === 0) return false
  // A shell call that only reads is not a mutation; a call that writes, moves,
  // deletes, or runs a formatter/test that rewrites files is.
  return /(^|[;&|]\s*|\s)(rm|mv|cp|touch|mkdir|rmdir|del|erase|copy|move|New-Item|Remove-Item|Set-Content|Add-Content|Out-File|tee)\b|>\s*[^\s|]|git\s+(commit|merge|rebase|cherry-pick|reset|checkout|switch|stash\s+pop)|npm\s+(install|uninstall|ci)|pnpm\s+(add|remove|install)|pip\s+install|--write|--fix|-w\b/i.test(command)
}

/**
 * The message injected into the agent when a turn is held open.
 * @param {string} reason
 * @param {number} nudge
 * @param {'warn'|'strict'} mode
 * @param {string} evidenceDir
 */
export function nudgeText(reason, nudge, mode, evidenceDir) {
  return [
    `[dsh-claimcheck ${mode === 'strict' ? 'gate' : 'reminder'} ${nudge}] 本轮改动了工作区，但还没有可用的验收证据：${reason}。`,
    '在把这件事说成“已完成”之前，先取证：调用 claim_verify（它会真正执行检查命令并记录退出码与输出）。',
    '如果 claim_verify 返回 fail 或 incomplete，修复问题后重新调用，直到它是 pass；确实无法验证的部分，要明确说出来，而不是当作通过。',
    `证据会写到 ${evidenceDir}/latest.json（可由人或其他工具读取）。`,
    '如果本轮其实没有交付任何需要验收的东西（例如只是回答问题），直接结束即可：本次提醒不会被重复计入。',
  ].join('\n')
}

/**
 * Render an artifact as Markdown for a handoff.
 * @param {any} artifact
 */
export function renderMarkdown(artifact) {
  const icon = artifact.verdict === 'pass' ? '✅' : artifact.verdict === 'fail' ? '❌' : '⚠️'
  const rows = artifact.checks.map((c) => `| ${statusMark(c.status)} | \`${c.id}\` | ${c.title} | ${escapePipes(c.detail)} |`)
  return [
    `## 验收证据 ${icon} ${artifact.verdict}`,
    '',
    `${artifact.summary}`,
    '',
    `- run: \`${artifact.runId}\``,
    `- digest: \`${artifact.digest}\``,
    `- 工作区指纹: \`${artifact.workspace.fingerprint}\` (${artifact.workspace.fingerprintSource})`,
    `- 记录时间: ${artifact.createdAt}`,
    '',
    '| | id | 检查 | 结果 |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}

/** @param {string} status */
function statusMark(status) {
  return status === 'pass' ? '✓' : status === 'fail' ? '✗' : status === 'unknown' ? '?' : '!'
}

/** @param {string} text */
function escapePipes(text) {
  return String(text).replace(/\|/g, '\\|')
}
