#!/usr/bin/env node

import { auditPromptVariablesWithSources, formatReport } from '../src/index.mjs'

const HELP = `prompt-variable-auditor

Audit a prompt template against the schema that declares its variables and the
value set a caller intends to interpolate. Reports placeholders nobody declared,
declarations nobody uses, required variables with no value, defaults that
contradict their own declaration, and values that would break out of the place
they are inserted into.

This tool renders nothing. No template is interpolated, no value is
substituted, and no file is written -- there is no step at which a supplied
value could become part of an instruction stream.

Usage:
  prompt-variable-auditor --template FILE --schema FILE --values FILE
                          [--json] [limits]

Options:
  --template FILE        The prompt template to audit (required)
  --schema FILE          JSON declaring each variable's type, context, whether
                         it is required, and its default (required)
  --values FILE          JSON supplying the values to be interpolated
                         (required). To audit with nothing supplied, pass a
                         file reading {"schemaVersion": "1", "values": {}} --
                         required variables then fail, which is the point
  --json                 Emit the machine-readable report on stdout
  --max-placeholders N   Maximum placeholders in a template (default 2000)
  --max-schema-bytes N   Maximum schema size (default 1048576)
  --max-template-bytes N Maximum template size (default 1048576)
  --max-value-chars N    Maximum characters in one supplied value (default
                         65536). A longer value is not scanned, and a value
                         that was not scanned is not reported safe
  --max-values-bytes N   Maximum values size (default 1048576)
  --max-variables N      Maximum variables in a schema (default 500)
  --timeout-ms N         Time budget for the whole run (default 10000; 0 leaves
                         no time at all and is only useful for proving the
                         budget is enforced)
  -h, --help             Show this help

The placeholder grammar, in full, because "behaves predictably" is not a
property a grammar nobody wrote down can have:

  {{name}}        an interpolation. {{ opens it and the FIRST following }}
                  closes it. Scanning is left to right and never recursive
  \\{{name}}       escaped: literal text, not an interpolation. Backslashes
                  immediately before {{ are counted, and an ODD number escapes
  \\\\{{name}}      an escaped backslash followed by a REAL placeholder
  {{ {{name}} }}  ONE placeholder whose name is "{{name", which is not a usable
                  name and is reported as such. The trailing " }}" is literal.
                  Placeholders do not nest
  {{name          unterminated, and reported. Scanning stops there
  }}              with no opening {{, literal text. Not reported
  name            valid names match [A-Za-z_][A-Za-z0-9_]{0,63}

Contexts. Each variable declares one, and a supplied value is checked for what
would break out of it:

  text          a fence-free prose region. Refuses role and turn markers:
                <|im_start|>, [INST], <system>, <instructions>, and a
                conversational turn header (Human:, Assistant:, System:, User:)
                at the start of a line
  code          inside a fenced block. Refuses a fence run that would close it
  json-string   inside a JSON string literal. Refuses a quote, a backslash or a
                control character
  identifier    refuses anything outside [A-Za-z0-9_-]

  text and code are also INFERRED from where the placeholder actually sits, and
  a declaration that disagrees with every occurrence is reported. json-string
  and identifier are not inferred: a text template gives nothing to infer them
  from, so a declaration of either is taken at its word.

What cannot happen:

  - Interpolation is never re-entered. A value containing {{other}} stays
    literal, "other" never becomes a used variable, and the value is reported
    under value-placeholder-inert so the inertness is not mistaken for
    expansion.
  - A value is never quoted back. A finding names the MARKER it matched and
    where; the value itself never reaches the report.
  - A required variable with no value is an error, not a note.
  - Unknown evidence is never a pass. An unreadable, undecodable, unparseable
    or uninterpretable input, a limit reached, a value too long to scan, a time
    budget expired, or a template and schema that between them name no variable
    at all, each produce an "incomplete" report with NO per-variable verdicts,
    and exit 2.

Every option is accepted once; a repeated flag is a configuration error rather
than a silent last-wins. An unknown option is refused rather than ignored.

Exit codes:
  0  every variable lines up and every value is safe for its context
  1  at least one variable is stopped
  2  invalid usage (no report on stdout), or evidence that was missing,
     undecodable or bounded out (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-placeholders', 'maxPlaceholders'],
  ['--max-schema-bytes', 'maxSchemaBytes'],
  ['--max-template-bytes', 'maxTemplateBytes'],
  ['--max-value-chars', 'maxValueChars'],
  ['--max-values-bytes', 'maxValuesBytes'],
  ['--max-variables', 'maxVariables'],
  ['--timeout-ms', 'timeoutMs'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { template: null, schema: null, values: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--values production.json --values empty.json` audits against a value set
   * nobody asked for. That is the same defect as an ignored typo, which this
   * tool already refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') {
      once('--json')
      options.json = true
    } else if (argument === '--template') {
      once('--template')
      options.template = takeValue('--template')
    } else if (argument === '--schema') {
      once('--schema')
      options.schema = takeValue('--schema')
    } else if (argument === '--values') {
      once('--values')
      options.values = takeValue('--values')
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      const minimum = argument === '--timeout-ms' ? 0 : 1
      if (!/^\d+$/.test(raw) || Number(raw) < minimum) {
        throw new Error(`${argument} requires an integer of ${minimum} or more`)
      }
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  for (const name of ['template', 'schema', 'values']) {
    if (options[name] === null) throw new Error(`--${name} is required`)
  }
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let report
  let sources
  try {
    ;({ report, sources } = await auditPromptVariablesWithSources({
      template: options.template,
      schema: options.schema,
      values: options.values,
      limits: options.limits,
    }))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  // Which files were opened is a diagnostic, not data: it goes to stderr so
  // stdout stays parseable. It is never left unsaid, because an audit of the
  // wrong template is exactly the audit that comes back clean.
  process.stderr.write(`read ${sources.length} input(s); nothing was written and no template was rendered\n`)

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))

  if (report.status === 'incomplete') {
    process.stderr.write('incomplete: evidence was missing, undecodable or bounded out, so no verdict was produced.\n')
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
