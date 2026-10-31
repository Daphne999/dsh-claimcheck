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
 * @param {string} command
 * @param {{ workdir: string, timeoutMs?: number }} options
 */
export function runReal(command, options) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(shellProgram.program, [...shellProgram.args, command], {
      cwd: options.workdir,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    })
    /** @type {Buffer[]} */
    const out = []
    /** @type {Buffer[]} */
    const err = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    const timer = options.timeoutMs === undefined
      ? null
      : setTimeout(() => { try { child.kill() } catch { /* gone */ } }, options.timeoutMs)
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      resolve({ exitCode: null, signal: null, timedOut: false, stdout: { text: '' }, stderr: { text: String(error) }, durationMs: Date.now() - started })
    })
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolve({
        exitCode: code,
        signal: signal ?? null,
        timedOut: false,
        stdout: { text: Buffer.concat(out).toString('utf8') },
        stderr: { text: Buffer.concat(err).toString('utf8') },
        durationMs: Date.now() - started,
      })
    })
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
