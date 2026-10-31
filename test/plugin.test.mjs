import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFakeAgent, createFakeContext, makeWorkspace, callTool } from './helpers.mjs'
import { apply, isMutatingTool, nudgeText } from '../lib/index.js'

/**
 * Boot the plugin against a fake context and one fake agent.
 * @param {{ mode?: string, maxNudgesPerSession?: number, autoDiscover?: boolean }} [config]
 */
async function boot(config = {}) {
  const ws = await makeWorkspace({ 'app.js': 'console.log(1)\n' })
  const ctx = createFakeContext()
  apply(ctx, { mode: 'warn', ...config })
  const agent = createFakeAgent({ sessionId: 's-test', cwd: ws.dir })
  await ctx.fire('agent/created', { agent })
  return { ws, ctx, agent }
}

test('apply registers the four tools under one namespace', async () => {
  const { ws, ctx, agent } = await boot()
  try {
    for (const name of ['claim_plan', 'claim_verify', 'claim_status', 'claim_report']) {
      assert.ok(ctx.tools.get(name), `missing tool ${name}`)
      assert.equal(ctx.tools.get(name).name, name)
    }
    // Gate listeners are installed on the agent's scoped context.
    assert.equal(agent.listenerCount('agent/turn-stopping'), 1)
    assert.equal(agent.listenerCount('tools/result'), 1)
  } finally {
    ctx.disposeAll()
    await ws.cleanup()
  }
})

test('no plan and no discovery is an error that points at the fix', async () => {
  const { ws, ctx, agent } = await boot({ autoDiscover: false })
  try {
    await assert.rejects(
      () => callTool(ctx.tools.get('claim_verify'), {}, { agent }),
      /no plan and no discoverable checks/,
    )
    const status = await callTool(ctx.tools.get('claim_status'), {}, { agent })
    assert.equal(status.value.verdict, 'none')
    assert.equal(status.value.fresh, false)
  } finally {
    ctx.disposeAll()
    await ws.cleanup()
  }
})

test('verify runs real commands, records evidence, and reports pass', async () => {
  const { ws, ctx, agent } = await boot()
  try {
    const plan = await callTool(ctx.tools.get('claim_plan'), {
      checks: [
        { id: 'file-ok', kind: 'file', title: 'app.js exists', path: 'app.js' },
        { id: 'cmd-ok', kind: 'command', title: 'echo exits 0', command: 'echo verified' },
      ],
    }, { agent })
    assert.equal(plan.value.checks.length, 2)

    const verify = await callTool(ctx.tools.get('claim_verify'), {}, { agent })
    assert.equal(verify.value.verdict, 'pass', verify.text)
    assert.equal(verify.value.counts.total, 2)
    assert.equal(verify.value.counts.pass, 2)
    assert.equal(verify.value.digest.length, 64)
    assert.ok(verify.value.artifactPath.includes('.dsh'))

    const artifact = JSON.parse(await ws.read('.dsh/claimcheck/latest.json'))
    assert.equal(artifact.verdict, 'pass')
    assert.equal(artifact.plan.source, 'agent')
    assert.equal(artifact.checks[1].output.includes('verified'), true)
    assert.equal(artifact.workspace.fingerprint.length, 64)

    const status = await callTool(ctx.tools.get('claim_status'), {}, { agent })
    assert.equal(status.value.fresh, true)
    assert.equal(status.value.verdict, 'pass')

    const report = await callTool(ctx.tools.get('claim_report'), {}, { agent })
    assert.match(report.value.markdown, /验收证据/)
    assert.match(report.value.markdown, /cmd-ok/)
  } finally {
    ctx.disposeAll()
    await ws.cleanup()
  }
})

test('a failing check produces a fail verdict and the failure detail', async () => {
  const { ws, ctx, agent } = await boot()
  try {
    await ws.write('fail.js', 'process.exitCode = 7\n')
    const verify = await callTool(ctx.tools.get('claim_verify'), {
      checks: [
        { id: 'must-pass', kind: 'command', title: 'a real failure', command: 'node fail.js' },
      ],
    }, { agent })
    assert.equal(verify.value.verdict, 'fail')
    assert.equal(verify.value.counts.fail, 1)
    // The exact non-zero code depends on the shell tier (Windows PowerShell
    // reports 1 for a child's non-zero exit); the contract is "non-zero =
    // fail", recorded as such.
    assert.match(verify.text, /exit [1-9]/)
    const artifact = JSON.parse(await ws.read('.dsh/claimcheck/latest.json'))
    assert.notEqual(artifact.checks[0].exitCode, 0)
    assert.equal(artifact.checks[0].status, 'fail')
  } finally {
    ctx.disposeAll()
    await ws.cleanup()
  }
})

test('evidence goes stale after the tree changes', async () => {
  const { ws, ctx, agent } = await boot()
  try {
    const verify = await callTool(ctx.tools.get('claim_verify'), {
      checks: [{ id: 'c', kind: 'command', title: 'ok', command: 'echo ok' }],
    }, { agent })
    assert.equal(verify.value.verdict, 'pass')

    const fresh = await callTool(ctx.tools.get('claim_status'), {}, { agent })
    assert.equal(fresh.value.fresh, true)

    await ws.write('app.js', 'console.log(2)\n')
    const stale = await callTool(ctx.tools.get('claim_status'), {}, { agent })
    assert.equal(stale.value.fresh, false)
    assert.match(stale.value.headline, /不可用/)
  } finally {
    ctx.disposeAll()
    await ws.cleanup()
  }
})

test('a workspace change during the run downgrades the verdict to incomplete', async () => {
  const { ws, ctx, agent } = await boot()
  try {
    // The check itself mutates the tree: proof that the run cannot be pinned.
    const verify = await callTool(ctx.tools.get('claim_verify'), {
      checks: [{ id: 'mutate', kind: 'command', title: 'write during run', command: 'node -e "require(\'fs\').writeFileSync(\'app.js\',\'changed\')"' }],
    }, { agent })
    assert.equal(verify.value.verdict, 'incomplete')
    assert.match(verify.text, /changed while the checks were running/)
    const artifact = JSON.parse(await ws.read('.dsh/claimcheck/latest.json'))
    assert.equal(artifact.verdict, 'incomplete')
  } finally {
    ctx.disposeAll()
    await ws.cleanup()
  }
})

test('claim_plan rejects unsafe or malformed checks before recording', async () => {
  const { ws, ctx, agent } = await boot()
  try {
    await assert.rejects(
      () => callTool(ctx.tools.get('claim_plan'), { checks: [{ kind: 'command', title: 'nuke', command: 'rm -rf /' }] }, { agent }),
      /safety screen/,
    )
    await assert.rejects(
      () => callTool(ctx.tools.get('claim_plan'), { checks: [] }, { agent }),
      /at least one check/,
    )
    await assert.rejects(
      () => callTool(ctx.tools.get('claim_plan'), { checks: [{ kind: 'file', title: 'escape', path: '../x' }] }, { agent }),
      /inside the working directory/,
    )
  } finally {
    ctx.disposeAll()
    await ws.cleanup()
  }
})

test('gate stays quiet when no mutating tool ran this turn', async () => {
  const { ws, ctx, agent } = await boot({ mode: 'strict' })
  try {
    await agent.fire('agent/turn-stopping', { turn: 1 })
    assert.equal(agent.followups.length, 0)
  } finally {
    ctx.disposeAll()
    await ws.cleanup()
  }
})

test('gate nudges once after a write with no evidence, then respects the budget', async () => {
  const { ws, ctx, agent } = await boot({ mode: 'warn', maxNudgesPerSession: 2 })
  try {
    await agent.fire('tools/result', { name: 'write' })
    await agent.fire('agent/turn-stopping', { turn: 1 })
    assert.equal(agent.followups.length, 1, 'one nudge')
    assert.match(agent.followups[0].content[0].text, /dsh-claimcheck/)
    assert.match(agent.followups[0].content[0].text, /claim_verify/)

    // The nudge itself resets the "work happened" flag, so an unchanged turn
    // does not nudge again.
    await agent.fire('agent/turn-stopping', { turn: 2 })
    assert.equal(agent.followups.length, 1, 'no duplicate nudge without new work')

    await agent.fire('tools/result', { name: 'edit' })
    await agent.fire('agent/turn-stopping', { turn: 3 })
    assert.equal(agent.followups.length, 2, 'second nudge for a second piece of work')

    await agent.fire('tools/result', { name: 'edit' })
    await agent.fire('agent/turn-stopping', { turn: 4 })
    assert.equal(agent.followups.length, 2, 'budget exhausted, gate goes quiet')
  } finally {
    ctx.disposeAll()
    await ws.cleanup()
  }
})

test('gate stays quiet when evidence is fresh, even after a write', async () => {
  const { ws, ctx, agent } = await boot({ mode: 'strict' })
  try {
    await callTool(ctx.tools.get('claim_verify'), {
      checks: [{ id: 'c', kind: 'command', title: 'ok', command: 'echo ok' }],
    }, { agent })
    await agent.fire('tools/result', { name: 'write' })
    await agent.fire('agent/turn-stopping', { turn: 1 })
    assert.equal(agent.followups.length, 0)
  } finally {
    ctx.disposeAll()
    await ws.cleanup()
  }
})

test('gate mode off never nudges', async () => {
  const { ws, ctx, agent } = await boot({ mode: 'off' })
  try {
    await agent.fire('tools/result', { name: 'write' })
    await agent.fire('agent/turn-stopping', { turn: 1 })
    assert.equal(agent.followups.length, 0)
  } finally {
    ctx.disposeAll()
    await ws.cleanup()
  }
})

test('a throwing tools/result payload cannot break the pipeline', async () => {
  const { ws, ctx, agent } = await boot()
  try {
    await agent.fire('tools/result', null)
    await agent.fire('tools/result', { name: 42 })
    assert.ok(true)
  } finally {
    ctx.disposeAll()
    await ws.cleanup()
  }
})

test('isMutatingTool classifies shell commands conservatively', () => {
  assert.equal(isMutatingTool('write', {}), true)
  assert.equal(isMutatingTool('edit', {}), true)
  assert.equal(isMutatingTool('read', {}), false)
  assert.equal(isMutatingTool('bash', { arguments: { command: 'ls -la' } }), false)
  assert.equal(isMutatingTool('bash', { arguments: { command: 'npm test' } }), false)
  assert.equal(isMutatingTool('bash', { arguments: { command: 'rm -rf dist' } }), true)
  assert.equal(isMutatingTool('bash', { arguments: { command: 'echo hi > out.txt' } }), true)
  assert.equal(isMutatingTool('pwsh', { arguments: { command: 'New-Item x' } }), true)
  assert.equal(isMutatingTool('pwsh', { arguments: {} }), false)
})

test('nudgeText names the evidence path and never claims a pass', () => {
  const text = nudgeText('workspace changed', 1, 'strict', '.dsh/claimcheck')
  assert.match(text, /claim_verify/)
  assert.match(text, /\.dsh\/claimcheck/)
  assert.doesNotMatch(text, /验收结论/)
  assert.match(text, /而不是当作通过/)
})
