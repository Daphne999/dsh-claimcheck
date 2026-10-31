#!/usr/bin/env node
/**
 * End-to-end smoke test: boots the plugin against a workspace that looks like
 * a real project, then drives it through the whole contract the way a session
 * would — plan, mutate, verify, go stale, verify again, report.
 *
 * This is deliberately not part of `npm test`: it prints a human-readable
 * transcript and exercises real child processes, so it doubles as a demo.
 *
 *   node scripts/smoke.mjs
 */
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { apply } from '../lib/index.js'

const shellProgram = process.platform === 'win32'
  ? { program: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command'] }
  : { program: '/bin/bash', args: ['-c'] }

function runReal(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(shellProgram.program, [...shellProgram.args, command], { cwd, windowsHide: true })
    const out = []
    const err = []
    child.stdout.on('data', c => out.push(c))
    child.stderr.on('data', c => err.push(c))
    const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : null
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolve({ exitCode: code, signal: signal ?? null, timedOut: false, stdout: { text: Buffer.concat(out).toString() }, stderr: { text: Buffer.concat(err).toString() } })
    })
  })
}

/** Minimal host context: only the two services the plugin requires. */
function createContext() {
  const tools = new Map()
  const listeners = new Map()
  const shell = {
    resolve: request => request,
    async execute(spec) {
      const result = await runReal(spec.command, spec.workdir, spec.timeoutMs)
      return { result: async () => result }
    },
  }
  return {
    shell,
    tools: {
      register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) },
      get: name => tools.get(name),
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => listeners.set(event, (listeners.get(event) ?? []).filter(l => l !== listener))
    },
    effect(dispose) { return dispose },
    async fire(event, payload) {
      for (const listener of listeners.get(event) ?? []) await listener(payload)
    },
    tools_,
  }
  function tools_() { return tools }
}

function createAgent(cwd) {
  const listeners = new Map()
  const followups = []
  return {
    id: 'agent-smoke',
    session: { id: 'session-smoke', header: { cwd } },
    followups,
    ctx: {
      on(event, listener) {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
        return () => listeners.set(event, (listeners.get(event) ?? []).filter(l => l !== listener))
      },
    },
    async followup(message) { followups.push(message) },
    async fire(event, payload) {
      for (const listener of listeners.get(event) ?? []) await listener(payload)
    },
  }
}

async function callTool(tool, args, agent) {
  const value = await tool.execute(args, { agent, signal: undefined })
  const content = tool.output.render(args, value)
  return { value, text: content.map(c => c.text).join('\n') }
}

const step = (n, title) => console.log(`\n── ${n}. ${title}`)

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'claimcheck-smoke-'))
  const ctx = createContext()
  apply(ctx, { mode: 'warn' })
  const tools = ctx.tools_()
  const agent = createAgent(dir)
  await ctx.fire('agent/created', { agent })

  try {
    step(1, 'workspace: a tiny node project whose test can be made to fail')
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'demo',
      scripts: { test: 'node --test' },
    }, null, 2))
    await mkdir(join(dir, 'test'), { recursive: true })
    await writeFile(join(dir, 'sum.js'), 'export const sum = (a, b) => a + b\n')
    await writeFile(join(dir, 'test', 'sum.test.js'), [
      "import { test } from 'node:test'",
      "import assert from 'node:assert/strict'",
      "import { sum } from '../sum.js'",
      "test('sums', () => assert.equal(sum(2, 3), 5))",
      '',
    ].join('\n'))
    console.log('   wrote package.json, sum.js, test/sum.test.js')

    step(2, 'auto-discovery finds the project test command (no plan needed)')
    const first = await callTool(tools.get('claim_verify'), {}, agent)
    console.log(first.text.split('\n').map(l => `   ${l}`).join('\n'))

    step(3, 'the agent then changes sum.js and the old evidence goes stale')
    await writeFile(join(dir, 'sum.js'), 'export const sum = (a, b) => a - b\n')
    await agent.fire('tools/result', { name: 'write' })
    const stale = await callTool(tools.get('claim_status'), {}, agent)
    console.log(`   ${stale.text.replace(/\n/g, '\n   ')}`)

    step(4, 'the turn tries to end: the gate reminds, and does not let a stale pass stand')
    await agent.fire('agent/turn-stopping', { turn: 3 })
    console.log(`   followups queued: ${agent.followups.length}`)
    console.log(agent.followups.at(-1)?.content?.[0]?.text?.split('\n').slice(0, 3).map(l => `   ${l}`).join('\n'))

    step(5, 're-verify: the broken implementation now fails, verdict is fail')
    const failed = await callTool(tools.get('claim_verify'), {}, agent)
    console.log(failed.text.split('\n').slice(0, 4).map(l => `   ${l}`).join('\n'))

    step(6, 'fix the implementation and verify again: pass, pinned to the new fingerprint')
    await writeFile(join(dir, 'sum.js'), 'export const sum = (a, b) => a + b\n')
    const passed = await callTool(tools.get('claim_verify'), {
      checks: [{ id: 'unit', kind: 'command', title: 'node --test exits 0', command: 'node --test' }],
    }, agent)
    console.log(passed.text.split('\n').map(l => `   ${l}`).join('\n'))

    step(7, 'the artifact on disk is plain JSON anyone can read')
    const latest = JSON.parse(await readFile(join(dir, '.dsh', 'claimcheck', 'latest.json'), 'utf8'))
    console.log(`   schema=${latest.schema} verdict=${latest.verdict} digest=${latest.digest.slice(0, 16)}…`)
    console.log(`   workspace=${latest.workspace.fingerprint.slice(0, 16)}… (${latest.workspace.fingerprintSource})`)

    step(8, 'handoff report')
    const report = await callTool(tools.get('claim_report'), {}, agent)
    console.log(report.text.split('\n').slice(0, 8).map(l => `   ${l}`).join('\n'))

    step(9, 'a fresh turn that does nothing needs no evidence: the gate stays quiet')
    const before = agent.followups.length
    await agent.fire('agent/turn-stopping', { turn: 4 })
    console.log(`   additional followups: ${agent.followups.length - before}`)

    console.log('\nSMOKE OK')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('\nSMOKE FAILED:', error)
  process.exitCode = 1
})
