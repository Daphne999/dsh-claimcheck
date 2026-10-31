import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defineTool } from '../lib/schema.js'

test('defineTool compiles required scalar parameters and validates calls', async () => {
  const tool = defineTool({
    name: 'demo',
    description: 'demo',
    parameters: {
      id: { type: 'string', required: true, description: 'the id' },
      count: { type: 'integer' },
      mode: { type: 'string', enum: ['a', 'b'] },
    },
    render: (_args, value) => [{ type: 'text', text: String(value.ok) }],
    async execute(args) { return { ok: true, args } },
  })

  assert.equal(tool.name, 'demo')
  assert.deepEqual(tool.parameters.required, ['id'])
  assert.equal(tool.parameters.properties.id.type, 'string')
  assert.deepEqual(tool.parameters.properties.mode.enum, ['a', 'b'])

  const result = await tool.execute({ id: 'x', count: 2 }, {})
  assert.equal(result.ok, true)

  await assert.rejects(() => tool.execute({ count: 2 }, {}), /id is required/)
  await assert.rejects(() => tool.execute({ id: 'x', count: 1.5 }, {}), /count must be integer/)
  await assert.rejects(() => tool.execute({ id: 'x', mode: 'c' }, {}), /mode must be one of a, b/)
})

test('defineTool compiles nested array/object specs', async () => {
  const tool = defineTool({
    name: 'nested',
    description: 'nested',
    parameters: {
      items: { type: 'array', items: { type: 'string' } },
      meta: { type: 'object', additionalProperties: false, properties: { tag: { type: 'string', required: true } } },
    },
    render: () => [{ type: 'text', text: 'ok' }],
    async execute(args) { return args },
  })
  assert.equal(tool.parameters.properties.items.type, 'array')
  assert.equal(tool.parameters.properties.items.items.type, 'string')
  assert.equal(tool.parameters.properties.meta.additionalProperties, false)

  await tool.execute({ items: ['a'], meta: { tag: 't' } }, {})
  await assert.rejects(() => tool.execute({ items: ['a', 2] }, {}), /items\[1\] must be string/)
  await assert.rejects(() => tool.execute({ meta: {} }, {}), /meta\.tag is required/)
  await assert.rejects(() => tool.execute({ meta: { tag: 't', extra: 1 } }, {}), /extra is not a declared property/)
})
