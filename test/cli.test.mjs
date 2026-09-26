/**
 * The command-line surface.
 *
 * Exit 2 has two shapes and this file pins both: a USAGE error means the run
 * never had a subject, so stdout is empty; an INPUT that could not be read
 * means the run had a subject and failed to obtain evidence about it, so stdout
 * carries an `incomplete` report naming which input.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { prepare, runCli, variable, workspace, writeFixture } from './helpers.mjs'

test('--help explains the tool and exits 0', async () => {
  for (const flag of ['--help', '-h']) {
    const run = await runCli([flag])
    assert.equal(run.code, 0)
    assert.match(run.stdout, /prompt-variable-auditor/)
    assert.match(run.stdout, /This tool renders nothing/)
    assert.match(run.stdout, /The placeholder grammar, in full/)
    assert.match(run.stdout, /Exit codes:/)
    assert.equal(run.stderr, '')
  }
})

test('the help states the whole grammar, including the cases that are refusals', async () => {
  const help = (await runCli(['--help'])).stdout
  for (const phrase of [
    'the FIRST following }}', 'an ODD number escapes', 'Placeholders do not nest',
    'unterminated', 'literal text. Not reported',
  ]) {
    assert.ok(help.includes(phrase), `--help must state: ${phrase}`)
  }
})

test('an unknown option is refused, not ignored', async () => {
  const run = await runCli(['--template', 't.md', '--schema', 's.json', '--values', 'v.json', '--strict'])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '', 'a usage error never emits a report')
  assert.match(run.stderr, /Unknown option "--strict"/)
})

test('a one-character typo in a limit flag cannot turn a real failure into a green run', async (t) => {
  const directory = await workspace(t)
  const { args } = await prepare(directory, 'Do {{task}}', [variable({ required: true })], {})
  const run = await runCli([...args, '--max-variable', '1'])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /Unknown option "--max-variable"/)
})

test('a repeated flag is a configuration error rather than a silent last-wins', async (t) => {
  const directory = await workspace(t)
  const { args } = await prepare(directory, 'Do {{task}}', [variable()], { task: 'x' })
  const run = await runCli([...args, '--values', 'somewhere-else.json'])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /--values was given more than once/)
})

test('all three inputs must be named', async () => {
  for (const [args, expected] of [
    [[], /--template is required/],
    [['--template', 't.md'], /--schema is required/],
    [['--template', 't.md', '--schema', 's.json'], /--values is required/],
  ]) {
    const run = await runCli(args)
    assert.equal(run.code, 2)
    assert.equal(run.stdout, '')
    assert.match(run.stderr, expected)
  }
})

test('--values is required, and the empty value set is how you audit with nothing supplied', async (t) => {
  const directory = await workspace(t)
  const help = (await runCli(['--help'])).stdout
  assert.match(help, /"schemaVersion": "1", "values": \{\}/)
  const { args } = await prepare(directory, 'Do {{task}}', [variable({ required: true })], {})
  const run = await runCli([...args, '--json'])
  assert.equal(run.code, 1, 'required variables then fail, which is the point')
  assert.ok(JSON.parse(run.stdout).findings.some((finding) => finding.ruleId === 'variable-required-missing'))
})

test('a flag that needs a value and does not get one is refused', async () => {
  const run = await runCli(['--template', '--schema', 's.json', '--values', 'v.json'])
  assert.equal(run.code, 2)
  assert.match(run.stderr, /--template requires a value/)
})

test('a limit flag rejects anything that is not an integer in range', async (t) => {
  const directory = await workspace(t)
  const { args } = await prepare(directory, 'Do {{task}}', [variable()], { task: 'x' })
  for (const value of ['0', 'many', '-1', '2.5']) {
    const run = await runCli([...args, '--max-variables', value])
    assert.equal(run.code, 2, `--max-variables ${value} must be refused`)
    assert.equal(run.stdout, '')
  }
  assert.equal((await runCli([...args, '--timeout-ms', '0'])).code, 2, 'but --timeout-ms 0 is a real value')
})

test('stdout in --json mode is nothing but the report', async (t) => {
  const directory = await workspace(t)
  const { args } = await prepare(directory, 'Do {{task}}', [variable({ required: true })], {})
  const run = await runCli([...args, '--json'])
  const parsed = JSON.parse(run.stdout)
  assert.equal(parsed.tool, 'prompt-variable-auditor')
  assert.equal(parsed.schemaVersion, '1')
  assert.notEqual(run.stderr, '', 'diagnostics go to stderr, where they cannot break a pipe')
  assert.match(run.stderr, /nothing was written and no template was rendered/)
})

test('the human report always states that nothing was rendered', async (t) => {
  const directory = await workspace(t)
  const cases = [
    { variables: [variable()], values: { task: 'x' } },
    { variables: [variable({ required: true })], values: {} },
    { variables: [], template: 'no placeholders' },
  ]
  for (const item of cases) {
    const { args } = await prepare(directory, item.template ?? 'Do {{task}}', item.variables, item.values ?? {})
    const run = await runCli(args)
    assert.match(run.stdout, /No template was rendered and no value was interpolated\./)
  }
})

test('an unreadable input exits 2 WITH a report, unlike a usage error', async (t) => {
  const directory = await workspace(t)
  const templatePath = await writeFixture(directory, 'template.md', 'Do {{task}}')
  const schemaPath = await writeFixture(directory, 'variables.json', { schemaVersion: '1', variables: [] })
  const usage = await runCli(['--template'])
  assert.equal(usage.code, 2)
  assert.equal(usage.stdout, '')

  const unreadable = await runCli([
    '--template', templatePath, '--schema', schemaPath, '--values', `${directory}/gone.json`, '--json',
  ])
  assert.equal(unreadable.code, 2)
  assert.notEqual(unreadable.stdout, '')
  const report = JSON.parse(unreadable.stdout)
  assert.equal(report.status, 'incomplete')
  assert.ok(report.findings.some((finding) => finding.ruleId === 'values-unreadable'))
})
