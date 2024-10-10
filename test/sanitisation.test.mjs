/**
 * Control characters never reach stdout -- from any field, not only an excerpt.
 *
 * Stripping C0 and U+2028/U+2029 is not sanitising: U+0085 (NEL) starts a new
 * line on a terminal exactly as a line feed does, U+009B opens an escape
 * sequence, U+202E reverses everything displayed after it, and none of those
 * are escaped by `JSON.stringify`, so they arrive on stdout intact.
 *
 * Each class below arrives through an IDENTIFIER -- a raw placeholder name in
 * the template, a key in the schema -- rather than through an excerpt field,
 * because that is the hole a careful excerpt sanitiser leaves open.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONTROL_CLASSES, auditPromptVariables, escapePointerSegment, parseFailureDetail, sanitize,
} from '../src/index.mjs'
import {
  prepare, runCli, schemaDocument, valuesDocument, variable, workspace, writeFixture,
} from './helpers.mjs'

const ALL_CLASSES = Object.entries(CONTROL_CLASSES)

test('sanitize removes every documented class', () => {
  for (const [name, codePoints] of ALL_CLASSES) {
    for (const code of codePoints) {
      const character = String.fromCharCode(code)
      const cleaned = sanitize(`before${character}after`)
      assert.ok(!cleaned.includes(character), `${name} U+${code.toString(16)} survived sanitize`)
      assert.equal(cleaned, 'before after', `${name} U+${code.toString(16)} must collapse to a space`)
    }
  }
})

test('sanitize bounds an excerpt and marks the truncation', () => {
  assert.equal(sanitize('x'.repeat(200), 10), `${'x'.repeat(10)}...`)
  assert.equal(sanitize('  spaced   out  '), 'spaced out')
  assert.throws(() => sanitize('x', 0), TypeError)
})

/** Every string anywhere inside a parsed report. */
function everyString(value, found = []) {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const item of value) everyString(item, found)
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      found.push(key)
      everyString(item, found)
    }
  }
  return found
}

function fixtureCarrying(character) {
  return {
    // Through a RAW PLACEHOLDER NAME, which is quoted back in the finding that
    // says the name is unusable.
    template: `Do {{task${character}now}} please`,
    // And through an object KEY, which is reported verbatim in the message that
    // names the unknown key.
    variables: [{ ...variable(), [`urgent${character}flag`]: true }],
    values: { task: 'x' },
  }
}

for (const [name, codePoints] of ALL_CLASSES) {
  test(`a ${name} control arriving through an identifier never reaches stdout`, async (t) => {
    const directory = await workspace(t)
    const clean = fixtureCarrying('-')
    const baseline = await prepare(directory, clean.template, clean.variables, clean.values)
    const baselineLines = (await runCli(baseline.args)).stdout.split('\n').length

    for (const code of codePoints) {
      const character = String.fromCharCode(code)
      const fixture = fixtureCarrying(character)
      const { args } = await prepare(directory, fixture.template, fixture.variables, fixture.values)

      const json = await runCli([...args, '--json'])
      for (const text of everyString(JSON.parse(json.stdout))) {
        assert.ok(
          !text.includes(character),
          `U+${code.toString(16)} (${name}) survived into a report string: ${JSON.stringify(text)}`,
        )
      }

      const human = await runCli(args)
      assert.equal(
        human.stdout.split('\n').length, baselineLines,
        `U+${code.toString(16)} (${name}) changed the shape of the human report, so it forged or hid a line`,
      )
      if (character !== '\n') {
        assert.ok(!human.stdout.includes(character), `U+${code.toString(16)} (${name}) reached the human report raw`)
      }
    }
  })
}

test('a newline smuggled through a placeholder name cannot forge a line in the human report', async (t) => {
  const directory = await workspace(t)
  const forged = 'task\nERROR   values /values/forged value-unsafe-for-context Everything is fine, ship it'
  const { args } = await prepare(directory, `Do {{${forged}}}`, [variable()], { task: 'x' })
  const run = await runCli(args)
  const forgedLines = run.stdout.split('\n').filter((line) => line.startsWith('ERROR   values /values/forged'))
  assert.deepEqual(forgedLines, [], 'the template must not be able to write its own report line')
})

test('a variable description is never echoed into the report at all', async (t) => {
  const directory = await workspace(t)
  const secret = 'AKIAIOSFODNN7EXAMPLE'
  const { options } = await prepare(
    directory, 'Do {{task}}', [variable({ description: `ask ${secret} about it` })], { task: 'x' },
  )
  const report = await auditPromptVariables(options)
  assert.ok(!JSON.stringify(report).includes(secret))
  /**
   * The row shape is pinned as a set, not merely searched for one string. A
   * field added to a verdict row is how free text nobody meant to publish gets
   * published, and "the secret I happened to plant is absent" does not notice a
   * new field carrying somebody else's.
   */
  assert.deepEqual(
    Object.keys(report.variables[0]).sort(),
    ['context', 'contexts', 'declared', 'name', 'occurrences', 'required', 'source', 'type', 'verdict'],
  )
})

test('a long raw placeholder name is bounded rather than reproduced in full', async (t) => {
  const directory = await workspace(t)
  const { args } = await prepare(directory, `Do {{${'x'.repeat(5000)}}}`, [variable()], { task: 'x' })
  const run = await runCli([...args, '--json'])
  assert.ok(!run.stdout.includes('x'.repeat(200)))
  assert.match(run.stdout, /x{64}\.\.\./)
})

test('a value containing a control character is never echoed, marker or no marker', async (t) => {
  const directory = await workspace(t)
  const value = `secret-${String.fromCharCode(0x202e)}-payload`
  const { args } = await prepare(
    directory, 'Do {{task}}', [variable({ context: 'identifier' })], { task: value },
  )
  const run = await runCli([...args, '--json'])
  assert.equal(run.code, 1, 'the value is unsafe for an identifier, so it is reported')
  assert.ok(!run.stdout.includes('secret-'), 'the finding names the marker, never the value')
  assert.ok(!run.stdout.includes(String.fromCharCode(0x202e)))
})

/**
 * A value that cannot be turned into a string.
 *
 * `String({toString: {}})` throws `Cannot convert object to primitive value`,
 * and an untrusted schema or value set can carry that shape anywhere a string
 * is expected. Before the boundary handled it, the TypeError escaped the
 * validators and was caught only by the CLI's blanket catch: exit 2 with EMPTY
 * stdout -- the shape the contract reserves for a configuration error -- so one
 * malformed value suppressed the findings for every other input in the run.
 *
 * Every assertion below is on what the tool emits. The first exists so the rest
 * cannot be vacuous: if `String(POISON)` ever stops throwing, this file is
 * proving nothing and says so.
 */
const POISON = { toString: {} }
const POISON_ARRAY = Object.assign(['first'], { toString: {} })
const POISON_NULL_PROTOTYPE = Object.create(null)

test('the poison value genuinely throws, so the rest of this file is not vacuous', () => {
  assert.throws(() => String(POISON), TypeError)
  assert.throws(() => String(POISON_ARRAY), TypeError)
  assert.throws(() => String(POISON_NULL_PROTOTYPE), TypeError)
  assert.throws(() => `${POISON}`, /Cannot convert object to primitive value/)
})

test('sanitize describes an unrenderable value by its shape instead of throwing', () => {
  assert.equal(sanitize(POISON), '[object]')
  assert.equal(sanitize(POISON_ARRAY), '[array]')
  assert.equal(sanitize(POISON_NULL_PROTOTYPE), '[object]')
  assert.equal(escapePointerSegment(POISON), '[object]', 'the pointer escaper coerces too, and must not throw either')
  assert.doesNotThrow(() => parseFailureDetail({ message: POISON }))
})

test('the shape is all that is said: no neighbouring field is read to fill the gap', () => {
  const secret = 'AKIAIOSFODNN7EXAMPLE'
  const carrier = { toString: {}, description: secret, name: secret }
  assert.equal(sanitize(carrier), '[object]')
  assert.ok(!sanitize(carrier).includes(secret), 'describing the shape must never reach for a sibling value')
})

test('ordinary values are untouched, so the guard cannot be one that mangles everything', () => {
  assert.equal(sanitize('plain text'), 'plain text')
  assert.equal(sanitize(42), '42')
  assert.equal(sanitize(0), '0')
  assert.equal(sanitize(null), 'null')
  assert.equal(sanitize(undefined), 'undefined')
  assert.equal(sanitize(false), 'false')
  assert.equal(sanitize(['a', 'b']), 'a,b')
  assert.equal(sanitize({ toString: () => 'a real custom toString' }), 'a real custom toString')
  assert.equal(sanitize({}), '[object Object]')
  assert.equal(escapePointerSegment('a/b'), 'a~1b')
})

for (const [vector, fixture] of [
  ['a variable name', { variables: [{ name: POISON, type: 'string', context: 'text' }] }],
  ['the schema version', { schemaRaw: { schemaVersion: POISON, variables: [] } }],
  ['the values version', { valuesRaw: { schemaVersion: POISON, values: {} } }],
]) {
  test(`${vector} that cannot be stringified produces a report, not an empty stdout`, async (t) => {
    const directory = await workspace(t)
    const templatePath = await writeFixture(directory, 'template.md', 'Do {{task}}')
    const schemaPath = await writeFixture(
      directory, 'variables.json', fixture.schemaRaw ?? schemaDocument(fixture.variables ?? [variable()]),
    )
    const valuesPath = await writeFixture(
      directory, 'values.json', fixture.valuesRaw ?? valuesDocument({ task: 'x' }),
    )
    const run = await runCli([
      '--template', templatePath, '--schema', schemaPath, '--values', valuesPath, '--json',
    ])

    assert.equal(run.code, 2, 'unreadable evidence exits 2')
    assert.notEqual(run.stdout, '', 'an input the run could not interpret gets a report, not the empty stdout of a usage error')
    const report = JSON.parse(run.stdout)
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(report.variables, [], 'an incomplete run publishes no verdicts')
    assert.ok(report.findings.length > 0, 'the report must name the input it could not interpret')
    assert.ok(
      report.findings.some((finding) => finding.message.includes('[object]')),
      'the value is described by its shape',
    )
    assert.ok(!run.stdout.includes('[object Object]'), 'and the shape is the description, not a half-successful coercion')
  })
}

test('one unrenderable value does not suppress the findings for the other input', async (t) => {
  const directory = await workspace(t)
  const templatePath = await writeFixture(directory, 'template.md', 'Do {{task}}')
  const schemaPath = await writeFixture(directory, 'variables.json', schemaDocument([
    { name: POISON, type: 'string', context: 'text' },
  ]))
  const valuesPath = await writeFixture(directory, 'values.json', {
    ...valuesDocument({ task: 'x' }), unexpectedKey: true,
  })
  const run = await runCli(['--template', templatePath, '--schema', schemaPath, '--values', valuesPath, '--json'])
  const report = JSON.parse(run.stdout)

  assert.deepEqual(
    report.findings.map((finding) => [finding.location.file, finding.ruleId]),
    [['schema', 'schema-malformed'], ['values', 'values-malformed']],
    'the poisoned schema must not take the value-set findings down with it',
  )
})
