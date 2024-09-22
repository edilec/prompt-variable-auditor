/**
 * The schema and value-set validators.
 *
 * Pure functions of their arguments: nothing here reads a file, a clock, a
 * locale or the environment, and nothing renders a template.
 */

import { CONTEXTS, NAME_PATTERN } from './template.mjs'
import { byCodeUnit, escapePointerSegment, sanitize } from './text.mjs'

export const SCHEMA_VERSION = '1'
export const VALUES_VERSION = '1'

/**
 * The declarable types.
 *
 * Three, and no `object` or `array`. A template interpolates text; an object
 * rendered into a prompt is whatever `String()` makes of it, which is
 * `[object Object]` often enough that accepting the declaration would be
 * promising something this tool cannot check.
 */
export const TYPES = Object.freeze(['boolean', 'number', 'string'])

const VARIABLE_KEYS = Object.freeze(['context', 'default', 'description', 'name', 'required', 'type'])

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function problem(ruleId, pointer, message) {
  return { ruleId, pointer, message }
}

/** The JSON type name of a supplied value, for a type-mismatch message. */
export function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'a non-finite number'
  return typeof value
}

function matchesType(value, type) {
  if (type === 'string') return typeof value === 'string'
  if (type === 'boolean') return typeof value === 'boolean'
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Validate the variable schema.
 *
 * `required: true` together with a `default` is refused rather than tolerated.
 * The two cannot both be true of the same variable: a variable with a default
 * can never be missing, so declaring it required is a statement the tool would
 * have to ignore, and a reader of the schema would take it for a guarantee that
 * a caller must supply one.
 */
export function validateSchemaDocument(document) {
  const problems = []
  if (!isPlainObject(document)) {
    problems.push(problem('schema-malformed', '', 'The schema document is not a JSON object.'))
    return { variables: [], problems }
  }
  for (const key of Object.keys(document)) {
    if (key !== 'schemaVersion' && key !== 'variables') {
      problems.push(problem('schema-malformed', '', `The schema document declares the unknown key "${sanitize(key, 40)}".`))
    }
  }
  if (document.schemaVersion !== SCHEMA_VERSION) {
    problems.push(problem(
      'schema-version-unsupported', '/schemaVersion',
      `This tool reads schemaVersion "${SCHEMA_VERSION}"; the document declares `
      + `${document.schemaVersion === undefined ? 'none' : `"${sanitize(document.schemaVersion, 40)}"`}.`,
    ))
    return { variables: [], problems }
  }
  if (!Array.isArray(document.variables)) {
    problems.push(problem('schema-malformed', '/variables', '"variables" must be an array.'))
    return { variables: [], problems }
  }

  const variables = []
  const seen = new Set()
  for (let index = 0; index < document.variables.length; index += 1) {
    const raw = document.variables[index]
    const indexPointer = `/variables/${index}`
    if (!isPlainObject(raw)) {
      problems.push(problem('schema-malformed', indexPointer, 'A variable entry is not a JSON object.'))
      continue
    }
    const usableName = typeof raw.name === 'string' && NAME_PATTERN.test(raw.name)
    const pointer = usableName ? `/variables/${escapePointerSegment(raw.name)}` : indexPointer
    let ok = true
    if (!usableName) {
      problems.push(problem(
        'schema-malformed', `${indexPointer}/name`,
        `"name" must match ${NAME_PATTERN.source}; the entry declares `
        + `${raw.name === undefined ? 'none' : `"${sanitize(raw.name, 64)}"`}.`,
      ))
      ok = false
    } else if (seen.has(raw.name)) {
      problems.push(problem('variable-duplicate', pointer, `The schema declares "${sanitize(raw.name, 64)}" more than once.`))
      ok = false
    }
    for (const key of Object.keys(raw)) {
      if (!VARIABLE_KEYS.includes(key)) {
        problems.push(problem('variable-unknown-key', pointer, `The variable declares the unknown key "${sanitize(key, 40)}".`))
        ok = false
      }
    }
    if (typeof raw.type !== 'string' || !TYPES.includes(raw.type)) {
      problems.push(problem('schema-malformed', `${pointer}/type`, `"type" must be one of: ${TYPES.join(', ')}.`))
      ok = false
    }
    if (raw.required !== undefined && typeof raw.required !== 'boolean') {
      problems.push(problem('schema-malformed', `${pointer}/required`, '"required" must be a boolean.'))
      ok = false
    }
    if (typeof raw.context !== 'string' || !CONTEXTS.includes(raw.context)) {
      problems.push(problem(
        'schema-malformed', `${pointer}/context`,
        `"context" is required and must be one of: ${CONTEXTS.join(', ')}. `
        + 'A variable whose context nobody declared cannot be checked for what would break out of it.',
      ))
      ok = false
    }
    if (raw.description !== undefined && typeof raw.description !== 'string') {
      problems.push(problem('schema-malformed', `${pointer}/description`, '"description" must be a string.'))
      ok = false
    }
    if (raw.default !== undefined && raw.required === true) {
      problems.push(problem(
        'variable-required-with-default', pointer,
        'The variable is declared required AND carries a default. A variable with a default can never be '
        + 'missing, so one of the two declarations is not true, and a reader would take the other for a guarantee.',
      ))
      ok = false
    }
    if (raw.default !== undefined && ok && !matchesType(raw.default, raw.type)) {
      problems.push(problem(
        'schema-malformed', `${pointer}/default`,
        `"default" is ${typeOf(raw.default)} but "type" is "${raw.type}".`,
      ))
      ok = false
    }
    if (usableName) seen.add(raw.name)
    if (!ok) continue
    variables.push({
      name: raw.name,
      type: raw.type,
      required: raw.required === true,
      context: raw.context,
      hasDefault: raw.default !== undefined,
      default: raw.default,
      pointer,
    })
  }
  variables.sort((left, right) => byCodeUnit(left.name, right.name))
  return { variables, problems }
}

/** Validate the supplied value set. */
export function validateValuesDocument(document) {
  const problems = []
  if (!isPlainObject(document)) {
    problems.push(problem('values-malformed', '', 'The values document is not a JSON object.'))
    return { values: new Map(), problems }
  }
  for (const key of Object.keys(document)) {
    if (key !== 'schemaVersion' && key !== 'values') {
      problems.push(problem('values-malformed', '', `The values document declares the unknown key "${sanitize(key, 40)}".`))
    }
  }
  if (document.schemaVersion !== VALUES_VERSION) {
    problems.push(problem(
      'values-version-unsupported', '/schemaVersion',
      `This tool reads values schemaVersion "${VALUES_VERSION}"; the document declares `
      + `${document.schemaVersion === undefined ? 'none' : `"${sanitize(document.schemaVersion, 40)}"`}.`,
    ))
    return { values: new Map(), problems }
  }
  if (!isPlainObject(document.values)) {
    problems.push(problem('values-malformed', '/values', '"values" must be a JSON object.'))
    return { values: new Map(), problems }
  }
  const values = new Map()
  for (const name of Object.keys(document.values).sort(byCodeUnit)) {
    values.set(name, document.values[name])
  }
  return { values, problems }
}

/** Is this supplied value of the declared type? */
export function valueMatchesType(value, type) {
  return matchesType(value, type)
}
