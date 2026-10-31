import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('package manifest declares the bundle patch and runtime exports', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-claimcheck')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.license, 'MIT')
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  assert.ok(pkg.files.includes('icon.svg'))
  assert.ok(pkg.keywords.includes('dsh-plugin'))
})

test('the bundle patch inserts exactly the documented row', async () => {
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: dsh-claimcheck/)
  assert.match(patch, /name: dsh-claimcheck/)
})

test('every file the manifest promises to ship exists', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  for (const path of ['lib/index.js', 'lib/schema.js', 'lib/checks.js', 'lib/fingerprint.js', 'lib/evidence.js',
    'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE', 'CHANGELOG.md', 'locale/en.json', 'locale/zh.json']) {
    const text = await readFile(join(root, path), 'utf8')
    assert.ok(text.length > 0, `empty: ${path}`)
    assert.ok(pkg.files.some((pattern) => {
      const normalized = pattern.replace('**/*.js', '').replace('*.json', '').replace('*', '')
      return path === pattern || path.startsWith(normalized)
    }), `not covered by package.json files: ${path}`)
  }
})

test('locale metadata carries a real title and description', async () => {
  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(await readFile(join(root, 'locale', `${locale}.json`), 'utf8')).meta
    assert.ok(meta.title.length > 2, `${locale} title`)
    assert.ok(meta.description.length > 20, `${locale} description`)
    assert.doesNotMatch(meta.title, /template|TODO|lorem/i)
  }
})

test('the icon is a valid SVG with a viewBox', async () => {
  const svg = await readFile(join(root, 'icon.svg'), 'utf8')
  assert.match(svg, /<svg[^>]+viewBox="0 0 64 64"/)
  assert.match(svg, /<\/svg>/)
  assert.ok(Buffer.byteLength(svg, 'utf8') < 256 * 1024)
})

test('runtime modules carry no @deepseek-ai imports', async () => {
  const files = await readdir(join(root, 'lib'))
  for (const file of files.filter(f => f.endsWith('.js'))) {
    const text = await readFile(join(root, 'lib', file), 'utf8')
    assert.doesNotMatch(text, /from '@deepseek-ai\//, `${file} imports a harness package at runtime`)
    assert.doesNotMatch(text, /require\('@deepseek-ai\//, `${file} requires a harness package at runtime`)
  }
})
