import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createFakeContext, makeWorkspace } from './helpers.mjs'
import { fingerprint, gitIdentity } from '../lib/fingerprint.js'
import { runCheck } from '../lib/evidence.js'
import { buildArtifact, verdictOf, freshnessOf, readLatestEvidence, persistEvidence, artifactDigest } from '../lib/evidence.js'

/** @param {object} shell */
const ctxShell = (shell) => ({ shell })

test('fingerprint falls back to files for a non-git directory and changes when a file changes', async () => {
  const ws = await makeWorkspace({ 'a.txt': 'one' })
  const ctx = createFakeContext()
  try {
    const identity = await gitIdentity({ shell: ctx.shell, cwd: ws.dir })
    assert.equal(identity.isRepo, false)

    const first = await fingerprint({ shell: ctx.shell, cwd: ws.dir })
    assert.equal(first.source, 'files')
    const second = await fingerprint({ shell: ctx.shell, cwd: ws.dir })
    assert.equal(first.digest, second.digest, 'unchanged tree keeps the digest')

    await ws.write('a.txt', 'two')
    const third = await fingerprint({ shell: ctx.shell, cwd: ws.dir })
    assert.notEqual(first.digest, third.digest, 'changed tree changes the digest')
  } finally {
    await ws.cleanup()
  }
})

test('fingerprint uses git state for a repository', async () => {
  const ws = await makeWorkspace({ 'a.txt': 'one' })
  const ctx = createFakeContext()
  try {
    const { dir } = ws
    assert.equal((await runGit(ctx, dir, 'init -q')), 0)
    assert.equal((await runGit(ctx, dir, 'config user.email t@example.com')), 0)
    assert.equal((await runGit(ctx, dir, 'config user.name t')), 0)
    assert.equal((await runGit(ctx, dir, 'add .')), 0)
    assert.equal((await runGit(ctx, dir, 'commit -q -m init')), 0)

    const identity = await gitIdentity({ shell: ctx.shell, cwd: dir })
    assert.equal(identity.isRepo, true)

    const clean = await fingerprint({ shell: ctx.shell, cwd: dir })
    assert.equal(clean.source, 'git')
    assert.equal(clean.detail.dirtyFiles, 0)

    await ws.write('a.txt', 'changed')
    const dirty = await fingerprint({ shell: ctx.shell, cwd: dir })
    assert.notEqual(clean.digest, dirty.digest)
    assert.equal(dirty.detail.dirtyFiles, 1)
  } finally {
    await ws.cleanup()
  }
})

async function runGit(ctx, cwd, args) {
  const execution = await ctx.shell.execute(ctx.shell.resolve({ command: `git ${args}`, workdir: cwd }))
  const result = await execution.result()
  return result.exitCode
}

test('command checks pass, fail and time out truthfully', async () => {
  const ws = await makeWorkspace({})
  const ctx = createFakeContext()
  try {
    const passing = await runCheck({
      check: { id: 'ok', kind: 'command', title: 'echo', command: 'echo hello', timeoutMs: 20_000, expectExitCode: 0, required: true },
      cwd: ws.dir,
      shell: ctx.shell,
    })
    assert.equal(passing.status, 'pass')
    assert.match(passing.output, /hello/)

    const failing = await runCheck({
      check: { id: 'bad', kind: 'command', title: 'exit 1', command: 'exit 1', timeoutMs: 20_000, expectExitCode: 0, required: true },
      cwd: ws.dir,
      shell: ctx.shell,
    })
    assert.equal(failing.status, 'fail')
    assert.equal(failing.exitCode, 1)

    const expected = await runCheck({
      check: { id: 'exp', kind: 'command', title: 'expects 3', command: 'exit 3', timeoutMs: 20_000, expectExitCode: 3, required: true },
      cwd: ws.dir,
      shell: ctx.shell,
    })
    assert.equal(expected.status, 'pass')
  } finally {
    await ws.cleanup()
  }
})

test('file checks verify presence and content', async () => {
  const ws = await makeWorkspace({ 'README.md': '# hello world\n', 'dir/nested.txt': 'needle' })
  const ctx = createFakeContext()
  try {
    const present = await runCheck({ check: { id: 'f1', kind: 'file', title: 'readme', path: 'README.md', required: true }, cwd: ws.dir, shell: ctx.shell })
    assert.equal(present.status, 'pass')
    const missing = await runCheck({ check: { id: 'f2', kind: 'file', title: 'nope', path: 'nope.md', required: true }, cwd: ws.dir, shell: ctx.shell })
    assert.equal(missing.status, 'fail')
    const contains = await runCheck({ check: { id: 'f3', kind: 'file', title: 'contains', path: 'dir/nested.txt', contains: 'needle', required: true }, cwd: ws.dir, shell: ctx.shell })
    assert.equal(contains.status, 'pass')
    const regex = await runCheck({ check: { id: 'f4', kind: 'file', title: 'regex', path: 'README.md', contains: '^# hello', regex: true, required: true }, cwd: ws.dir, shell: ctx.shell })
    assert.equal(regex.status, 'pass')
  } finally {
    await ws.cleanup()
  }
})

test('manual checks are never a pass on their own', async () => {
  const ws = await makeWorkspace({})
  const ctx = createFakeContext()
  try {
    const manual = await runCheck({
      check: { id: 'm', kind: 'manual', title: 'approved', requirement: 'product owner sign-off', required: true },
      cwd: ws.dir,
      shell: ctx.shell,
    })
    assert.equal(manual.status, 'unknown')
    assert.equal(verdictOf([{ check: { required: true }, status: 'unknown' }]), 'incomplete')
    assert.equal(verdictOf([{ check: { required: true }, status: 'pass' }, { check: { required: true }, status: 'unknown' }]), 'incomplete')
    assert.equal(verdictOf([{ check: { required: true }, status: 'pass' }]), 'pass')
    assert.equal(verdictOf([{ check: { required: true }, status: 'fail' }]), 'fail')
    assert.equal(verdictOf([{ check: { required: false }, status: 'unknown' }]), 'incomplete')
    assert.equal(verdictOf([]), 'incomplete')
  } finally {
    await ws.cleanup()
  }
})

test('evidence persists atomically, is digest-addressed, and reads back', async () => {
  const ws = await makeWorkspace({ 'a.txt': 'x' })
  const ctx = createFakeContext()
  try {
    const fp = await fingerprint({ shell: ctx.shell, cwd: ws.dir })
    const artifact = buildArtifact({
      plan: { id: 'p1', source: 'agent', checks: [] },
      results: [{
        id: 'c1', kind: 'command', title: 'echo', required: true, status: 'pass',
        detail: 'exit 0', exitCode: 0, signal: null, timedOut: false,
        outputDigest: 'abc', outputBytes: 3, outputTruncated: false, output: 'ok\n', durationMs: 5,
      }],
      verdict: 'pass',
      workspace: { cwd: ws.dir, fingerprint: fp },
      session: { id: 's1', agentId: 'a1', turn: 1 },
      startedAt: Date.now() - 10,
      finishedAt: Date.now(),
    })
    assert.equal(artifact.schema, 'dsh-claimcheck/evidence@1')
    assert.equal(artifact.digest.length, 64)
    assert.equal(artifact.digest, artifactDigest(artifact))
    assert.equal(artifact.summary.includes('1 checks'), true)

    const paths = await persistEvidence({ cwd: ws.dir, evidenceDir: '.dsh/claimcheck', artifact })
    assert.ok(paths.runPath.endsWith('.json'))
    const latest = await readLatestEvidence(ws.dir, '.dsh/claimcheck')
    assert.equal(latest.runId, artifact.runId)
    assert.equal(latest.digest, artifact.digest)

    const indexText = await ws.read('.dsh/claimcheck/index.jsonl')
    assert.match(indexText, new RegExp(artifact.runId))
  } finally {
    await ws.cleanup()
  }
})

test('freshness expires when the tree changes or the verdict is not pass', () => {
  const artifact = { workspace: { fingerprint: 'abc' }, verdict: 'pass' }
  assert.equal(freshnessOf(null, { digest: 'abc' }).fresh, false)
  assert.equal(freshnessOf(artifact, { digest: 'abc' }).fresh, true)
  assert.equal(freshnessOf(artifact, { digest: 'def' }).fresh, false)
  assert.equal(freshnessOf({ ...artifact, verdict: 'fail' }, { digest: 'abc' }).fresh, false)
  assert.equal(freshnessOf({ ...artifact, verdict: 'incomplete' }, { digest: 'abc' }).fresh, false)
})

test('readLatestEvidence tolerates missing, corrupt and foreign files', async () => {
  const ws = await makeWorkspace({})
  try {
    assert.equal(await readLatestEvidence(ws.dir, '.dsh/claimcheck'), null)
    await ws.write('.dsh/claimcheck/latest.json', '{not json')
    assert.equal(await readLatestEvidence(ws.dir, '.dsh/claimcheck'), null)
    await ws.write('.dsh/claimcheck/latest.json', JSON.stringify({ schema: 'other/thing' }))
    assert.equal(await readLatestEvidence(ws.dir, '.dsh/claimcheck'), null)
  } finally {
    await ws.cleanup()
  }
})
