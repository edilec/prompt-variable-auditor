/**
 * Unknown evidence is never a pass, and never half a verdict.
 *
 * When the run could not obtain the evidence it needed, it says so and produces
 * NO per-variable verdicts at all. A template audited halfway is not a smaller
 * answer: the variables that happened to be cleared before the budget ran out
 * would sit in a report looking checked.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { assertReportInvariants, auditPromptVariables } from '../src/index.mjs'
import { prepare, runCli, variable, workspace, writeFixture } from './helpers.mjs'

/** A monotonic clock that reads `0` for a while and then jumps past any budget. */
function clockThatJumpsAfter(readings) {
  const queue = [...readings]
  return () => (queue.length > 1 ? queue.shift() : queue[0])
}

test('a time budget expiring mid-loop discards the verdicts already reached', async (t) => {
  const directory = await workspace(t)
  const { options } = await prepare(
    directory,
    '{{alpha}} {{beta}} {{gamma}}',
    [variable({ name: 'alpha' }), variable({ name: 'beta' }), variable({ name: 'gamma' })],
    { alpha: 'a', beta: 'b', gamma: 'c' },
  )

  const unhurried = await auditPromptVariables(options)
  assert.equal(unhurried.status, 'pass')
  assert.equal(unhurried.summary.resolved, 3)

  // started = 0, first variable = 0, second variable = 9000: the budget expires
  // after one variable has already been cleared.
  const hurried = await auditPromptVariables({
    ...options,
    monotonic: clockThatJumpsAfter([0, 0, 9000]),
    limits: { timeoutMs: 1000 },
  })
  assert.equal(hurried.status, 'incomplete')
  assert.deepEqual(hurried.variables, [], 'no verdict survives a run that ran out of time')
  assert.equal(hurried.summary.checked, 0)
  assert.equal(hurried.summary.resolved, 0)
  assert.ok(!JSON.stringify(hurried).includes('"verdict"'), 'not one cleared row may leak into the report')
  const budget = hurried.findings.find((finding) => finding.ruleId === 'time-budget-exceeded')
  assert.match(budget.message, /1 of 3 variables/)
})

test('the documented timeout is wired through the CLI, and zero means zero', async (t) => {
  const directory = await workspace(t)
  const { args } = await prepare(directory, 'Do {{task}}', [variable()], { task: 'x' })
  assert.equal((await runCli([...args, '--timeout-ms', '10000'])).code, 0)
  const none = await runCli([...args, '--timeout-ms', '0', '--json'])
  assert.equal(none.code, 2)
  assert.equal(JSON.parse(none.stdout).status, 'incomplete')
})

test('a value too long to scan is not reported safe', async (t) => {
  const directory = await workspace(t)
  const { options } = await prepare(directory, 'Do {{task}}', [variable()], { task: 'x'.repeat(100) })

  assert.equal((await auditPromptVariables(options)).status, 'pass')
  const bounded = await auditPromptVariables({ ...options, limits: { maxValueChars: 10 } })
  assert.equal(bounded.status, 'incomplete')
  assert.deepEqual(bounded.variables, [])
  const finding = bounded.findings.find((entry) => entry.ruleId === 'value-too-large')
  assert.match(finding.message, /was not scanned for markers and cannot be called safe/)
})

test('one uninterpretable declaration withdraws the verdict on the whole template', async (t) => {
  const directory = await workspace(t)
  const { options } = await prepare(
    directory,
    '{{fine_one}} {{fine_two}} {{broken}}',
    [variable({ name: 'fine_one' }), variable({ name: 'fine_two' }), { name: 'broken', type: 'colour', context: 'text' }],
    { fine_one: 'a', fine_two: 'b', broken: 'c' },
  )
  const report = await auditPromptVariables(options)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.variables, [])
  assert.ok(!report.findings.some((finding) => finding.ruleId === 'variable-unresolved'))
})

test('every unreadable input is named, so a consumer knows which one to fix', async (t) => {
  const directory = await workspace(t)
  const report = await auditPromptVariables({
    template: `${directory}/absent-template.md`,
    schema: `${directory}/absent-schema.json`,
    values: `${directory}/absent-values.json`,
  })
  assert.deepEqual(
    report.findings.map((finding) => [finding.location.file, finding.ruleId]),
    [['schema', 'schema-unreadable'], ['template', 'template-unreadable'], ['values', 'values-unreadable']],
  )
  assert.equal(report.status, 'incomplete')
})

/**
 * The guard on the vacuous pass.
 *
 * `no-variables` is a WARNING, so the `incomplete: true` beside it is the only
 * thing between an empty audit and a green exit 0. That makes it exactly the
 * kind of invariant that is true by accident until somebody deletes one line.
 */
test('a template and schema that name no variable cannot exit 0', async (t) => {
  const directory = await workspace(t)
  const { args } = await prepare(directory, 'A prompt with no placeholders at all.', [], {})
  const run = await runCli([...args, '--json'])
  assert.equal(run.code, 2)
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'no-variables'))

  assert.deepEqual(
    assertReportInvariants({ ...report, status: 'pass' }),
    ['a pass was produced with nothing checked'],
    'the production invariant, not just this test, refuses a pass over no evidence',
  )
})

test('the production invariants refuse every shape of a dishonest report', async (t) => {
  const directory = await workspace(t)
  const { options } = await prepare(directory, 'Hello {{name}}', [variable({ name: 'name', required: true })], {})
  const report = await auditPromptVariables(options)
  assert.deepEqual(assertReportInvariants(report), [], 'the real report is honest')

  assert.deepEqual(assertReportInvariants({ ...report, status: 'pass' }), ['a pass was produced with error findings'])
  assert.deepEqual(
    assertReportInvariants({ ...report, status: 'incomplete' }),
    ['an incomplete run produced per-variable verdicts'],
  )
  assert.deepEqual(
    assertReportInvariants({ ...report, findings: report.findings.map((finding) => ({ ...finding, severity: 'info' })) }),
    ['finding "variable-required-missing" carries a severity the table does not declare'],
  )
  assert.deepEqual(
    assertReportInvariants({ ...report, variables: report.variables.map((entry) => ({ ...entry, verdict: 'ok' })) }),
    [
      'variable "name" was cleared while carrying an error finding',
      'required variable "name" was cleared with no value',
    ],
  )
})

test('an input that could not be parsed still produces a report on stdout, per the contract', async (t) => {
  const directory = await workspace(t)
  const templatePath = await writeFixture(directory, 'template.md', 'Do {{task}}')
  const schemaPath = await writeFixture(directory, 'variables.json', '{"schemaVersion": "1", "variables": [')
  const valuesPath = await writeFixture(directory, 'values.json', { schemaVersion: '1', values: {} })
  const run = await runCli(['--template', templatePath, '--schema', schemaPath, '--values', valuesPath, '--json'])
  assert.equal(run.code, 2)
  assert.notEqual(run.stdout, '', 'an unreadable INPUT exits 2 with a report; only a usage error exits 2 silent')
  assert.equal(JSON.parse(run.stdout).status, 'incomplete')
})

test('limits are enforced, not merely accepted', async (t) => {
  const directory = await workspace(t)
  const { options } = await prepare(
    directory,
    '{{alpha}} {{beta}} {{gamma}}',
    [variable({ name: 'alpha' }), variable({ name: 'beta' }), variable({ name: 'gamma' })],
    { alpha: 'a', beta: 'b', gamma: 'c' },
  )
  assert.equal((await auditPromptVariables(options)).status, 'pass')
  // maxValueChars and timeoutMs have their own tests above, because neither
  // bites on this fixture: the values are one character long and the run is
  // instant.
  for (const limits of [
    { maxVariables: 2 }, { maxPlaceholders: 2 }, { maxTemplateBytes: 8 },
    { maxSchemaBytes: 8 }, { maxValuesBytes: 8 },
  ]) {
    assert.equal(
      (await auditPromptVariables({ ...options, limits })).status, 'incomplete',
      `${Object.keys(limits)[0]} must actually bite`,
    )
  }
})

test('an unknown limit key is refused rather than ignored', async (t) => {
  const directory = await workspace(t)
  const { options } = await prepare(directory, 'Do {{task}}', [variable()], { task: 'x' })
  await assert.rejects(
    () => auditPromptVariables({ ...options, limits: { maxVariable: 1 } }),
    /Unknown limit "maxVariable"/,
  )
})
