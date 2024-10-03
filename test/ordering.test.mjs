/**
 * Ordering, pinned behaviourally.
 *
 * Scanning this tool's own source for `.localeCompare(` is not a determinism
 * test: substituting `Intl.Collator` produces identical collation drift with
 * different source text, so the scan passes while the output silently becomes
 * machine-dependent.
 *
 * So the names below are chosen because code-unit order and collation order
 * genuinely DISAGREE about them. Measured on this machine's ICU data:
 *
 *   code unit:  Zebra, a_two, aXone     collation:  a_two, aXone, Zebra
 *
 * `Z` (0x5A) precedes `a` (0x61) by code unit while collation sorts case as a
 * secondary difference, and `X` (0x58) precedes `_` (0x5F) while collation
 * treats the underscore as ignorable punctuation. Substituting a collator
 * anywhere on the report path flips both and fails this file.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { auditPromptVariables, byCodeUnit } from '../src/index.mjs'
import { prepare, variable, workspace } from './helpers.mjs'

const DISAGREEING = ['Zebra', 'aXone', 'a_two']

test('the comparator itself orders by code unit', () => {
  assert.equal(byCodeUnit('Zebra', 'aXone'), -1)
  assert.equal(byCodeUnit('aXone', 'a_two'), -1)
  assert.equal(byCodeUnit('README', 'assets'), -1)
  assert.equal(byCodeUnit('same', 'same'), 0)
  for (const [left, right] of [['Zebra', 'aXone'], ['aXone', 'a_two'], ['README', 'assets']]) {
    assert.notEqual(
      Math.sign(left.localeCompare(right)), byCodeUnit(left, right),
      `${left} vs ${right} must be a pair the two orderings disagree about, or this file proves nothing`,
    )
  }
})

test('verdict rows come back in code-unit order of the variable name', async (t) => {
  const directory = await workspace(t)
  // Declared and interpolated deliberately out of order, so emission order
  // cannot be what is being observed.
  const reversed = [...DISAGREEING].reverse()
  const { options } = await prepare(
    directory,
    reversed.map((name) => `{{${name}}}`).join(' '),
    reversed.map((name) => variable({ name, required: true })),
    {},
  )
  const report = await auditPromptVariables(options)
  assert.deepEqual(report.variables.map((entry) => entry.name), ['Zebra', 'aXone', 'a_two'])
  assert.notDeepEqual(
    report.variables.map((entry) => entry.name),
    [...DISAGREEING].sort((left, right) => left.localeCompare(right)),
    'collation would emit a_two, aXone, Zebra; this report must not',
  )
})

test('findings come back in code-unit order of their pointers', async (t) => {
  const directory = await workspace(t)
  const { options } = await prepare(
    directory,
    DISAGREEING.map((name) => `{{${name}}}`).join(' '),
    DISAGREEING.map((name) => variable({ name, required: true })),
    {},
  )
  const report = await auditPromptVariables(options)
  assert.deepEqual(
    report.findings.map((finding) => finding.location.pointer),
    ['/variables/Zebra', '/variables/aXone', '/variables/a_two'],
  )
})

test('location.file is the primary sort key, ahead of the pointer', async (t) => {
  const directory = await workspace(t)
  // A schema finding with a LATE pointer and a template finding with an EARLY
  // one. If the pointer were compared first, /offset/0 would come before
  // /variables/zzz and this order would reverse.
  const { options } = await prepare(
    directory, '{{aaa}}', [variable({ name: 'zzz', default: 'x' })], {},
  )
  const report = await auditPromptVariables(options)
  assert.deepEqual(
    report.findings.map((finding) => [finding.location.file, finding.location.pointer]),
    [['schema', '/variables/zzz'], ['template', '/offset/0']],
  )
})

test('the rule id breaks a tie between two findings sharing a file and a pointer', async (t) => {
  const directory = await workspace(t)
  // Declared as text, interpolated inside a fence, required, and unsupplied:
  // context-mismatch and variable-required-missing both land on schema
  // /variables/shared, so only the rule id can separate them.
  const { options } = await prepare(
    directory,
    '```\n{{shared}}\n```\n',
    [variable({ name: 'shared', required: true, context: 'text' })],
    {},
  )
  const report = await auditPromptVariables(options)
  const here = report.findings.filter((finding) =>
    finding.location.file === 'schema' && finding.location.pointer === '/variables/shared')
  assert.equal(here.length, 2, 'both findings must genuinely share a file and a pointer, or this proves nothing')
  assert.deepEqual(
    here.map((finding) => finding.ruleId),
    ['context-mismatch', 'variable-required-missing'],
    '"context-" precedes "variable-" by code unit',
  )
})

test('the contexts listed on a verdict are ordered by code unit', async (t) => {
  const directory = await workspace(t)
  const { options } = await prepare(
    directory,
    '```\n{{shared}}\n```\n\nand inline {{shared}}',
    [variable({ name: 'shared' })],
    { shared: 'x' },
  )
  const report = await auditPromptVariables(options)
  assert.deepEqual(report.variables[0].contexts, ['code', 'text'], 'code precedes text, and the fenced one was seen first')
})
