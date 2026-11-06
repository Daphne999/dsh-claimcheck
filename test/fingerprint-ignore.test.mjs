import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_IGNORE_PATHS,
  fingerprint,
  isIgnoredPath,
  normalizeIgnorePaths,
} from '../lib/fingerprint.js'
import { createFakeContext, makeWorkspace } from './helpers.mjs'

/** The fake context's shell runs real commands (file-redirected, no pipes). */
function shellOf() {
  const ctx = createFakeContext()
  return ctx.shell
}

test('normalizeIgnorePaths defaults to the local data directory', () => {
  assert.deepEqual(normalizeIgnorePaths(undefined), DEFAULT_IGNORE_PATHS)
  assert.deepEqual(normalizeIgnorePaths('oops'), DEFAULT_IGNORE_PATHS)
  assert.deepEqual(normalizeIgnorePaths([]), [])
  assert.deepEqual(normalizeIgnorePaths(['notes', 'a\\b/']), ['notes/', 'a/b/'])
})

test('isIgnoredPath matches a directory prefix, an exact file, and nothing else', () => {
  const ignore = normalizeIgnorePaths(['notes/', 'tmp/'])
  assert.equal(isIgnoredPath('notes/one.md', ignore), true)
  assert.equal(isIgnoredPath('notes', ignore), true)
  assert.equal(isIgnoredPath('notes-two/one.md', ignore), false)
  assert.equal(isIgnoredPath('src/app.js', ignore), false)
})

test('a memory database change does not expire evidence by default', async () => {
  const ws = await makeWorkspace({ 'app.js': 'console.log(1)\n' })
  const shell = shellOf()
  try {
    await ws.write('.dsh-meow/memory.db', 'a'.repeat(64))
    const first = await fingerprint({ shell, cwd: ws.dir })
    assert.equal(first.source, 'files')

    await ws.write('.dsh-meow/memory.db', 'b'.repeat(512))
    const second = await fingerprint({ shell, cwd: ws.dir })
    assert.equal(second.digest, first.digest, 'ignored data file must not change the digest')

    await ws.write('app.js', 'console.log(2)\n// real change\n')
    const third = await fingerprint({ shell, cwd: ws.dir })
    assert.notEqual(third.digest, first.digest, 'a code change must change the digest')
  } finally {
    await ws.cleanup()
  }
})

test('configured ignorePaths replace the defaults', async () => {
  const ws = await makeWorkspace({ 'app.js': 'console.log(1)\n' })
  const shell = shellOf()
  try {
    await ws.write('notes/todo.md', 'one\n')
    await ws.write('.dsh-meow/memory.db', 'a'.repeat(64))
    const first = await fingerprint({ shell, cwd: ws.dir, ignorePaths: ['notes/'] })

    await ws.write('notes/todo.md', 'two\n')
    const second = await fingerprint({ shell, cwd: ws.dir, ignorePaths: ['notes/'] })
    assert.equal(second.digest, first.digest, 'configured ignored directory must not affect the digest')

    await ws.write('.dsh-meow/memory.db', 'b'.repeat(512))
    const third = await fingerprint({ shell, cwd: ws.dir, ignorePaths: ['notes/'] })
    assert.notEqual(third.digest, first.digest, 'defaults are replaced, so the memory file now counts')
  } finally {
    await ws.cleanup()
  }
})

test('the git fingerprint filters ignored untracked paths too', async () => {
  const ws = await makeWorkspace({ 'app.js': 'console.log(1)\n' })
  const shell = shellOf()
  try {
    const init = await shell.execute(shell.resolve({ command: 'git init -q', workdir: ws.dir }))
    assert.equal((await init.result()).exitCode, 0)
    for (const command of [
      'git add app.js',
      'git -c user.name=t -c user.email=t@example.com commit -q -m init',
    ]) {
      const execution = await shell.execute(shell.resolve({ command, workdir: ws.dir }))
      assert.equal((await execution.result()).exitCode, 0, command)
    }

    const first = await fingerprint({ shell, cwd: ws.dir })
    assert.equal(first.source, 'git')

    await ws.write('.dsh-meow/memory.db', 'x'.repeat(64))
    const second = await fingerprint({ shell, cwd: ws.dir })
    assert.equal(second.digest, first.digest, 'ignored untracked file must not dirty the fingerprint')

    await ws.write('notes.txt', 'a real untracked file\n')
    const third = await fingerprint({ shell, cwd: ws.dir })
    assert.notEqual(third.digest, first.digest, 'a normal untracked file must dirty the fingerprint')
  } finally {
    await ws.cleanup()
  }
})
