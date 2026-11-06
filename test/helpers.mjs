/**
 * Test scaffolding: a minimal Cordis-shaped context whose shell runs REAL
 * commands through PowerShell, plus a helper to build temp workspaces.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const IS_WINDOWS = process.platform === 'win32'

export function detectShell() {
  if (IS_WINDOWS) {
    const candidates = [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]
    return { program: candidates[1], args: ['-NoProfile', '-NonInteractive', '-Command'] }
  }
  return { program: '/bin/bash', args: ['-c'] }
}

const shellProgram = detectShell()

/**
 * Run a command with a real process and a bounded collector.
 *
 * Child stdout/stderr are redirected to files instead of pipes: a restricted
 * DSH sandbox (workspace-write) cannot create the named pipes that
 * `spawn(..., { stdio: 'pipe' })` needs, which shows up as `spawn EPERM` even
 * though running the command itself is allowed.
 *
 * @param {string} command
 * @param {{ workdir: string, timeoutMs?: number }} options
 */
export async function runReal(command, options) {
  const started = Date.now()
  const { openSync, closeSync, readFileSync, unlinkSync } = await import('node:fs')
  const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`
  const outPath = join(tmpdir(), `claimcheck-out-${stamp}.log`)
  const errPath = join(tmpdir(), `claimcheck-err-${stamp}.log`)
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  return await new Promise((resolve) => {
    let child
    try {
      child = spawn(shellProgram.program, [...shellProgram.args, command], {
        cwd: options.workdir,
        windowsHide: true,
        stdio: ['ignore', outFd, errFd],
        env: { ...process.env, NO_COLOR: '1' },
      })
    } catch (error) {
      try { closeSync(outFd); closeSync(errFd) } catch { /* closed */ }
      resolve({ exitCode: null, signal: null, timedOut: false, stdout: { text: '' }, stderr: { text: String(error) }, durationMs: Date.now() - started })
      return
    }
    let settled = false
    const timer = options.timeoutMs === undefined
      ? null
      : setTimeout(() => { try { child.kill() } catch { /* gone */ } }, options.timeoutMs)
    const finish = (code, signal, extra) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      let stdout = ''
      let stderr = ''
      try { stdout = readFileSync(outPath, 'utf8') } catch { /* unreadable */ }
      try { stderr = readFileSync(errPath, 'utf8') } catch { /* unreadable */ }
      try { closeSync(outFd); closeSync(errFd) } catch { /* closed */ }
      try { unlinkSync(outPath) } catch { /* gone */ }
      try { unlinkSync(errPath) } catch { /* gone */ }
      resolve({
        exitCode: code,
        signal: signal ?? null,
        timedOut: false,
        stdout: { text: stdout },
        stderr: { text: extra === undefined ? stderr : `${extra}${stderr}` },
        durationMs: Date.now() - started,
      })
    }
    child.on('error', (error) => finish(null, null, String(error)))
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/**
 * A fake host context that records registrations and lets tests fire events.
 * @param {{ config?: object }} [options]
 */
export function createFakeContext() {
  /** @type {Map<string, any>} */
  const tools = new Map()
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  /** @type {any[]} */
  const effects = []
  /** @type {any[]} */
  const promptSections = []
  /** @type {any[]} */
  const privileged = []

  const shell = {
    resolve(request) {
      return { ...request, resolvedAt: Date.now() }
    },
    async execute(spec) {
      const result = await runReal(spec.command, { workdir: spec.workdir, timeoutMs: spec.timeoutMs })
      return { result: async () => result }
    },
  }

  const ctx = {
    shell,
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
      get(name) { return tools.get(name) },
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        listeners.set(event, current.filter(l => l !== listener))
      }
    },
    effect(dispose, label) {
      effects.push({ dispose, label })
      return () => {
        try { dispose() } catch { /* ignore */ }
      }
    },
    systemPrompt: {
      section(section) {
        promptSections.push(section)
        return () => {}
      },
    },
    async fire(event, payload) {
      const list = listeners.get(event) ?? []
      const results = []
      for (const listener of list) results.push(await listener(payload))
      return results
    },
    listenerCount(event) { return (listeners.get(event) ?? []).length },
    disposeAll() {
      for (const { dispose } of effects) {
        try { dispose() } catch { /* ignore */ }
      }
      effects.length = 0
    },
    registeredTools: tools,
    effects,
    promptSections,
    privileged,
  }
  return ctx
}

/**
 * Build a fake agent handle scoped to a session/cwd, with its own listeners.
 * @param {{ sessionId: string, cwd: string, id?: string }} options
 */
export function createFakeAgent(options) {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  /** @type {any[]} */
  const followups = []
  const agent = {
    id: options.id ?? `agent-${options.sessionId}`,
    session: { id: options.sessionId, header: { cwd: options.cwd } },
    followups,
    ctx: {
      on(event, listener) {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
        return () => {
          const current = listeners.get(event) ?? []
          listeners.set(event, current.filter(l => l !== listener))
        }
      },
    },
    async followup(message) {
      followups.push(message)
    },
    async fire(event, payload) {
      const list = listeners.get(event) ?? []
      const results = []
      for (const listener of list) results.push(await listener(payload))
      return results
    },
    listenerCount(event) { return (listeners.get(event) ?? []).length },
  }
  return agent
}

/**
 * Create an isolated temp workspace.
 * @param {Record<string, string>} [files]
 */
export async function makeWorkspace(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'claimcheck-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return {
    dir,
    path(relative) { return join(dir, relative) },
    async write(relative, content) {
      const full = join(dir, relative)
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, content, 'utf8')
    },
    async read(relative) { return readFile(join(dir, relative), 'utf8') },
    async cleanup() { await rm(dir, { recursive: true, force: true }) },
  }
}

/**
 * Execute a registered tool as a fake agent run.
 * @param {any} tool
 * @param {object} args
 * @param {{ agent: any, signal?: AbortSignal }} options
 */
export async function callTool(tool, args, options) {
  const exec = { agent: options.agent, signal: options.signal }
  const value = await tool.execute(args, exec)
  const content = tool.output.render(args, value)
  return { value, content, text: content.map(c => c.text).join('\n') }
}
