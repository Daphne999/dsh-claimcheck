/**
 * Minimal self-contained tool-definition helpers.
 *
 * Deliberately zero `@deepseek-ai/*` runtime imports: an npm-mirror copy of
 * `@deepseek-ai/dsh-tools` placed in a profile's node_modules shadows the
 * CLI-internal build for the whole composition. This mirrors the structure
 * the registry actually consumes (raw JSON-Schema subset + output renderer)
 * and pre-validates arguments the same way.
 *
 * @module dsh-claimcheck/schema
 */

/** Author-facing scalar spec. */
/** @typedef {{ type: 'string'|'number'|'integer'|'boolean'|'null', description?: string, enum?: readonly unknown[] }} ScalarSpec */
/** @typedef {{ type: 'object', additionalProperties: boolean, description?: string, properties?: Readonly<Record<string, ValueSpec>> }} ObjectSpec */
/** @typedef {ScalarSpec|ObjectSpec|{type:'json'}|{type:'array', items?: ValueSpec, description?: string}} ValueSpec */
/** @typedef {ValueSpec & { required?: boolean }} ParameterSpec */
/** @typedef {Record<string, unknown>} RawSchema */

function compileValue(spec) {
  /** @type {RawSchema} */
  const node = {}
  const description = spec.description
  if (typeof description === 'string' && description.length > 0) node.description = description
  const type = spec.type
  if (type === undefined || type === 'json') return node
  if (type === 'object') {
    node.type = 'object'
    node.additionalProperties = spec.additionalProperties !== false
    if (spec.properties !== undefined) {
      const compiled = compilePropertyMap(spec.properties)
      node.properties = compiled.properties
      if (compiled.required !== undefined) node.required = compiled.required
    }
    return node
  }
  if (type === 'array') {
    node.type = 'array'
    if (spec.items !== undefined) node.items = compileValue(spec.items)
    return node
  }
  node.type = type
  if (spec.enum !== undefined) node.enum = [...spec.enum]
  return node
}

function compilePropertyMap(spec) {
  /** @type {Record<string, RawSchema>} */
  const properties = {}
  /** @type {string[]} */
  const required = []
  for (const [name, entry] of Object.entries(spec)) {
    const { required: isRequired, ...valueSpec } = entry
    properties[name] = compileValue(valueSpec)
    if (isRequired === true) required.push(name)
  }
  return required.length > 0 ? { properties, required } : { properties }
}

function matchesScalarType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number'
    case 'integer': return Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

function validateValue(schema, value, path) {
  if (typeof schema.type !== 'string' || schema.type.length === 0) return []
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path} must be an object`]
    /** @type {string[]} */
    const violations = []
    const present = /** @type {Record<string, unknown>} */ (value)
    for (const key of schema.required ?? []) {
      if (!(key in present)) violations.push(`${path}.${key} is required`)
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(present)) {
        if (!known.has(key)) violations.push(`${path}.${key} is not a declared property`)
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in present) violations.push(...validateValue(child, present[key], `${path}.${key}`))
    }
    return violations
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`]
    /** @type {string[]} */
    const violations = []
    if (schema.items !== undefined) {
      value.forEach((item, index) => { violations.push(...validateValue(schema.items, item, `${path}[${index}]`)) })
    }
    return violations
  }
  if (!matchesScalarType(value, schema.type)) return [`${path} must be ${schema.type}`]
  if (schema.enum !== undefined && !schema.enum.some(v => v === value)) {
    return [`${path} must be one of ${schema.enum.map(String).join(', ')}`]
  }
  return []
}

/**
 * Define a registry-ready tool.
 *
 * @template {Record<string, unknown>} A
 * @template V
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.description
 * @param {Readonly<Record<string, ParameterSpec>>} options.parameters
 * @param {(args: A, value: V) => Array<{type:'text', text:string}>} options.render
 * @param {(args: A, exec: unknown) => Promise<V>} options.execute
 */
export function defineTool(options) {
  const compiled = compilePropertyMap(options.parameters)
  /** @type {RawSchema} */
  const parameters = { type: 'object', properties: compiled.properties }
  if (compiled.required !== undefined) parameters.required = compiled.required
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: {},
      render: options.render,
    },
    async execute(args, exec) {
      const violations = validateValue(parameters, args, 'arguments')
      if (violations.length > 0) throw new Error(`Error: invalid arguments: ${violations.join('; ')}`)
      return options.execute(/** @type {A} */ (args), exec)
    },
  }
}
