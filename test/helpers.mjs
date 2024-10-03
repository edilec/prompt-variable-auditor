/**
 * Test scaffolding.
 *
 * `node:child_process` is imported HERE and nowhere in `src/` or `bin/`: the
 * tests have to start the CLI as a real process to observe an exit code, while
 * the tool itself must never be able to start anything at all.
 * `test/no-rendering.test.mjs` asserts that separation over the shipped source.
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const CLI = join(PACKAGE_ROOT, 'bin', 'prompt-variable-auditor.mjs')

/** A scratch directory removed when the test finishes, however it finishes. */
export async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'prompt-variable-auditor-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

export async function writeFixture(directory, name, contents) {
  const path = join(directory, name)
  await mkdir(dirname(path), { recursive: true })
  const body = typeof contents === 'string' || Buffer.isBuffer(contents)
    ? contents
    : `${JSON.stringify(contents, null, 2)}\n`
  await writeFile(path, body)
  return path
}

/** Run the CLI as a child process and capture the exit code and both streams. */
export function runCli(args, options = {}) {
  return new Promise((settle) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: options.cwd ?? PACKAGE_ROOT, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => settle({ code: error === null ? 0 : error.code, stdout, stderr }),
    )
  })
}

export function variable(overrides = {}) {
  return { name: 'task', type: 'string', context: 'text', ...overrides }
}

export function schemaDocument(variables, overrides = {}) {
  return { schemaVersion: '1', variables, ...overrides }
}

export function valuesDocument(values, overrides = {}) {
  return { schemaVersion: '1', values, ...overrides }
}

/**
 * Write a template, a schema and a value set, and return the argument list that
 * audits them. Each call writes into the same scratch directory, so a test may
 * prepare several variations in turn.
 */
export async function prepare(directory, template, variables, values = {}) {
  const templatePath = await writeFixture(directory, 'template.md', template)
  const schemaPath = await writeFixture(directory, 'variables.json', schemaDocument(variables))
  const valuesPath = await writeFixture(directory, 'values.json', valuesDocument(values))
  return {
    templatePath,
    schemaPath,
    valuesPath,
    args: ['--template', templatePath, '--schema', schemaPath, '--values', valuesPath],
    options: { template: templatePath, schema: schemaPath, values: valuesPath },
  }
}
