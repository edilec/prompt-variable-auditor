/**
 * The documented catalog and the severity table agree, in both directions.
 *
 * This is a source-of-truth check, NOT the severity guard: two declarations
 * agreeing with each other are satisfied by one coordinated edit. The guard is
 * `test/severity-outcomes.test.mjs`, which drives each rule through the real
 * entry point and asserts what the tool observably concluded.
 *
 * What this file is for is the other failure: a rule that exists in the code and
 * is documented nowhere, or documented and no longer emitted, and a README that
 * promises behaviour the code does not have. Documentation overclaims are
 * defects here.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { CONTEXTS, DEFAULT_LIMITS, RULE_SEVERITY, TEXT_MARKERS, TOOL_ID, TYPES } from '../src/index.mjs'
import { PACKAGE_ROOT, runCli } from './helpers.mjs'

const readme = await readFile(join(PACKAGE_ROOT, 'README.md'), 'utf8')

/** The rows of the README's rule table, as `ruleId -> severity`. */
function documentedRules(text) {
  const rows = {}
  for (const line of text.split('\n')) {
    const match = /^\| `([a-z0-9-]+)` \| (error|warning|info) \| /.exec(line)
    if (match !== null) rows[match[1]] = match[2]
  }
  return rows
}

test('the tool id equals the directory name and is exported', () => {
  assert.equal(TOOL_ID, 'prompt-variable-auditor')
  assert.equal(TOOL_ID, PACKAGE_ROOT.split('/').at(-1))
})

test('every rule in the table is documented, and every documented rule exists', () => {
  const documented = documentedRules(readme)
  assert.ok(Object.keys(documented).length > 25, 'the table was not parsed at all')
  assert.deepEqual(
    Object.keys(RULE_SEVERITY).filter((ruleId) => documented[ruleId] === undefined), [],
    'a rule the code can emit that the README does not list',
  )
  assert.deepEqual(
    Object.keys(documented).filter((ruleId) => RULE_SEVERITY[ruleId] === undefined), [],
    'a rule the README promises that the code cannot emit',
  )
  for (const [ruleId, severity] of Object.entries(documented)) {
    assert.equal(RULE_SEVERITY[ruleId], severity, `${ruleId} is documented as ${severity}`)
  }
})

test('every severity is one of the three the contract allows', () => {
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.ok(['error', 'warning', 'info'].includes(severity), `${ruleId} has severity ${severity}`)
  }
})

test('the documented limits are the limits the code has', async () => {
  const help = (await runCli(['--help'])).stdout
  const flags = {
    maxPlaceholders: '--max-placeholders', maxSchemaBytes: '--max-schema-bytes',
    maxTemplateBytes: '--max-template-bytes', maxValueChars: '--max-value-chars',
    maxValuesBytes: '--max-values-bytes', maxVariables: '--max-variables', timeoutMs: '--timeout-ms',
  }
  assert.deepEqual(Object.keys(flags).sort(), Object.keys(DEFAULT_LIMITS).sort(), 'a limit with no flag is a limit nobody can set')
  for (const [key, flag] of Object.entries(flags)) {
    assert.ok(help.includes(flag), `${flag} is missing from --help`)
    assert.ok(
      readme.includes(`| \`${flag}\` | ${DEFAULT_LIMITS[key]} |`),
      `the README must document ${flag} as ${DEFAULT_LIMITS[key]}`,
    )
  }
})

test('the documented vocabularies are the vocabularies the code enforces', () => {
  assert.deepEqual(TYPES, ['boolean', 'number', 'string'])
  assert.deepEqual(CONTEXTS, ['code', 'identifier', 'json-string', 'text'])
  for (const value of [...TYPES, ...CONTEXTS]) {
    assert.ok(readme.includes(`\`${value}\``), `the README must document the value ${value}`)
  }
  assert.ok(!TYPES.includes('object') && !TYPES.includes('array'), 'the README says neither is offered')
})

test('every marker the code matches is listed in the README, and nothing else is promised', () => {
  for (const marker of TEXT_MARKERS) {
    const escaped = marker.replaceAll('|', '\\|')
    assert.ok(readme.includes(escaped), `the README must list the marker ${marker}`)
  }
  assert.match(readme, /It does not detect natural-language prompt injection/)
  assert.ok(
    !/detects? (prompt )?injection\b(?! is)/i.test(readme.replaceAll('It does not detect natural-language prompt injection', '')),
    'the README must not claim an injection detector this tool does not have',
  )
})

test('the README does not promise an output file this tool cannot write', () => {
  assert.match(readme, /no file is written/)
  assert.match(readme, /There is no `--out`/)
  const help = readme
  assert.ok(!/--out\b|--output\b/.test(help.replace('There is no `--out`', '')), 'no write flag may be documented')
})

test('the README quick start is a command that actually runs', async () => {
  const commands = [...readme.matchAll(/node bin\/prompt-variable-auditor\.mjs \\\n((?:\s+--[^\n]*\n)+)/g)]
  assert.equal(commands.length, 2, 'both quick-start commands must be found')
  for (const [, block] of commands) {
    const args = block.trim().split(/\s+/).filter((token) => token !== '\\')
    const run = await runCli(args)
    assert.ok([0, 1].includes(run.code), `the quick start exited ${run.code}: ${run.stderr}`)
  }
})

test('the grammar table in the README matches what the scanner does', async () => {
  for (const row of ['`{{name}}`', '`\\{{name}}`', '`\\\\{{name}}`', '`{{ {{name}} }}`', '`{{name`', '`}}`']) {
    assert.ok(readme.includes(row), `the grammar table must state ${row}`)
  }
  const help = (await runCli(['--help'])).stdout
  assert.match(help, /The placeholder grammar, in full/)
})
