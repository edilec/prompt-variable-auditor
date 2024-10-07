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

import { CONTROL_CLASSES, auditPromptVariables, sanitize } from '../src/index.mjs'
import { prepare, runCli, variable, workspace } from './helpers.mjs'

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
