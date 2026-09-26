/**
 * Two runs over the same inputs produce byte-identical stdout.
 *
 * This tool reads no clock that reaches the report -- the only injected clock
 * measures the time budget -- so there is nothing time-dependent to pin down
 * with a flag, and a run is reproducible on any machine at any moment.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { auditPromptVariables } from '../src/index.mjs'
import { prepare, runCli, variable, workspace, writeFixture } from './helpers.mjs'

const TEMPLATE = 'Review {{repository}} for {{focus}}:\n\n```diff\n{{diff}}\n```\n\nSigned, {{stranger}}.'
const VARIABLES = [
  variable({ name: 'repository', required: true }),
  variable({ name: 'focus', default: 'correctness' }),
  variable({ name: 'diff', required: true, context: 'code' }),
  variable({ name: 'unused_one', default: 'x' }),
]
const VALUES = { repository: 'edilec/tool', diff: 'a\n```\nb', spare: 'unused' }

test('the same inputs produce byte-identical stdout, run after run', async (t) => {
  const directory = await workspace(t)
  const { args } = await prepare(directory, TEMPLATE, VARIABLES, VALUES)
  const first = await runCli([...args, '--json'])
  const second = await runCli([...args, '--json'])
  assert.equal(first.code, 1)
  assert.equal(first.stdout, second.stdout)
  assert.notEqual(first.stdout.length, 0)
})

test('reordering the schema and the value set changes nothing about the report', async (t) => {
  const directory = await workspace(t)
  const forward = await prepare(directory, TEMPLATE, VARIABLES, VALUES)
  const forwardOut = (await runCli([...forward.args, '--json'])).stdout
  const backward = await prepare(
    directory,
    TEMPLATE,
    [...VARIABLES].reverse(),
    Object.fromEntries(Object.entries(VALUES).reverse()),
  )
  const backwardOut = (await runCli([...backward.args, '--json'])).stdout
  assert.equal(forwardOut, backwardOut)
})

/**
 * The fourth sort key is the one carrying the weight here.
 *
 * Two unknown keys at the top of the same document produce two findings with
 * the same `location.file`, no pointer at all and the same `ruleId`, so
 * `message` is the ONLY key that separates them. Without it the sort is stable
 * on emission order, emission order is the order the keys happen to sit in the
 * input, and stdout then depends on how somebody typed their JSON -- which the
 * README promises it does not. The same file name is reused for both runs so
 * that byte-identity is a fair comparison.
 */
test('two findings alike but for their message are ordered by it, not by the order of the input keys', async (t) => {
  const directory = await workspace(t)
  const templatePath = await writeFixture(directory, 'template.md', 'Do {{task}}')
  const valuesPath = await writeFixture(directory, 'values.json', { schemaVersion: '1', values: { task: 'x' } })
  const runOver = async (document) => {
    const schemaPath = await writeFixture(directory, 'variables.json', document)
    return runCli(['--template', templatePath, '--schema', schemaPath, '--values', valuesPath, '--json'])
  }

  const declared = '{"name":"task","type":"string","context":"text"}'
  const zzzFirst = await runOver(`{"schemaVersion":"1","zzz":1,"aaa":2,"variables":[${declared}]}`)
  const aaaFirst = await runOver(`{"schemaVersion":"1","aaa":2,"zzz":1,"variables":[${declared}]}`)
  assert.equal(zzzFirst.code, 2)
  assert.deepEqual(
    JSON.parse(zzzFirst.stdout).findings.map((finding) => finding.message),
    [
      'The schema document declares the unknown key "aaa".',
      'The schema document declares the unknown key "zzz".',
    ],
    'the message decides, so the document that lists zzz first still reports aaa first',
  )
  assert.equal(zzzFirst.stdout, aaaFirst.stdout, 'input key order reached stdout')
})

test('no timestamp reaches the report', async (t) => {
  const directory = await workspace(t)
  const { options } = await prepare(directory, TEMPLATE, VARIABLES, VALUES)
  const serialised = JSON.stringify(await auditPromptVariables(options))
  assert.doesNotMatch(serialised, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'a report carrying a clock reading is not reproducible')
})

test('two wildly different monotonic clocks agree, as long as neither expires', async (t) => {
  const directory = await workspace(t)
  const { options } = await prepare(directory, TEMPLATE, VARIABLES, VALUES)
  const early = await auditPromptVariables({ ...options, monotonic: () => 0 })
  const late = await auditPromptVariables({ ...options, monotonic: () => 4102444800000 })
  assert.equal(JSON.stringify(early), JSON.stringify(late))
})
