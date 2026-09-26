/**
 * prompt-variable-auditor
 *
 * Reads a prompt template, the schema that declares its variables, and the
 * value set a caller intends to interpolate, and reports what does not line up:
 * placeholders nobody declared, declarations nobody uses, required variables
 * with no value, defaults that contradict their own declaration, and values
 * that would break out of the place they are inserted into.
 *
 * It is static analysis. **It renders nothing.** No template is interpolated,
 * no value is substituted, and no output prompt is produced -- so there is no
 * step at which a supplied value could become part of the instruction stream.
 *
 * Four properties are structural rather than incidental:
 *
 * 1. **Interpolation is single-pass, and the audit says so.** A value
 *    containing `{{other}}` is data: it is never rescanned, `other` never
 *    becomes a used variable, and the value is reported under
 *    `value-placeholder-inert` so nobody mistakes the inertness for expansion.
 * 2. **A value never acquires instruction authority.** Every supplied value and
 *    every default is checked against its declared context for the structural
 *    markers that would end that context or open one the template did not open.
 *    The report names the MARKER, never the value.
 * 3. **A required variable with no value fails.** Not a warning, not a note:
 *    `variable-required-missing` is an error, the status is `fail`, and the CLI
 *    exits 1.
 * 4. **Unknown evidence is never a pass.** A template, schema or value set that
 *    could not be read, decoded, parsed or interpreted, a limit reached, a value
 *    too large to scan, or a time budget expired, each make the run
 *    `incomplete`, emit NO per-variable verdicts at all, and exit 2.
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { typeOf, validateSchemaDocument, validateValuesDocument, valueMatchesType } from './schema.mjs'
import {
  INFERRED_CONTEXTS, NAME_PATTERN, carriesPlaceholder, contextAt, fencedRanges, findPlaceholders, unsafeMarkerFor,
} from './template.mjs'
import { byCodeUnit, decodeUtf8, escapePointerSegment, parseFailureDetail, sanitize } from './text.mjs'

export {
  SCHEMA_VERSION, TYPES, VALUES_VERSION, typeOf, validateSchemaDocument, validateValuesDocument, valueMatchesType,
} from './schema.mjs'
export {
  CONTEXTS, INFERRED_CONTEXTS, NAME_PATTERN, TEXT_MARKERS, TURN_HEADER, carriesPlaceholder, contextAt,
  fencedRanges, findPlaceholders, unsafeMarkerFor,
} from './template.mjs'
export { CONTROL_CLASSES, byCodeUnit, decodeUtf8, escapePointerSegment, parseFailureDetail, sanitize } from './text.mjs'

export const TOOL_ID = 'prompt-variable-auditor'
export const REPORT_SCHEMA_VERSION = '1'

/**
 * Bounds are part of the contract, not a safety net.
 *
 * A template is ordinary untrusted input: it can be a generated 40 MB file or
 * declare a hundred thousand placeholders. Every limit is explicit, overridable
 * from the command line, and named in the finding when it is reached. Exceeding
 * one produces an `incomplete` report with no per-variable verdicts -- never a
 * quietly shorter audit, and never a pass.
 *
 * `maxValueChars` is the one worth explaining: a value too long to scan is a
 * value this tool cannot call safe. It is reported and the run is incomplete,
 * rather than waved through because checking it would have been slow.
 *
 * `timeoutMs` accepts 0, and 0 means "no time at all": the first check fires.
 * That is the only way to prove from the outside that the flag is wired through
 * to the audit loop at all.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxPlaceholders: 2000,
  maxSchemaBytes: 1048576,
  maxTemplateBytes: 1048576,
  maxValueChars: 65536,
  maxValuesBytes: 1048576,
  maxVariables: 500,
  timeoutMs: 10000,
})

/**
 * The authoritative rule severity table.
 *
 * Severity decides whether a run refuses. Spread across construction sites as a
 * literal it drifts silently, so every finding takes its severity from here and
 * an unknown rule id throws.
 *
 * This table is the source of truth. It is **not** the guard. Three
 * declarations agreeing with each other -- this table, the README's rule table,
 * and an expected-value map written out again in a test -- are all satisfied by
 * one coordinated edit. The guard is `test/severity-outcomes.test.mjs`, which
 * drives each rule through the real entry point and asserts the observable
 * outcome as a literal at the assertion site.
 */
export const RULE_SEVERITY = Object.freeze({
  'context-conflict': 'error',
  'context-mismatch': 'error',
  'no-variables': 'warning',
  'placeholder-name-invalid': 'error',
  'placeholder-unterminated': 'error',
  'schema-malformed': 'error',
  'schema-not-json': 'error',
  'schema-not-utf8': 'error',
  'schema-too-large': 'error',
  'schema-unreadable': 'error',
  'schema-version-unsupported': 'error',
  'template-not-utf8': 'error',
  'template-too-large': 'error',
  'template-unreadable': 'error',
  'time-budget-exceeded': 'error',
  'too-many-placeholders': 'error',
  'too-many-variables': 'error',
  'value-placeholder-inert': 'error',
  'value-too-large': 'error',
  'value-type-mismatch': 'error',
  'value-undeclared': 'warning',
  'value-unsafe-for-context': 'error',
  'values-malformed': 'error',
  'values-not-json': 'error',
  'values-not-utf8': 'error',
  'values-too-large': 'error',
  'values-unreadable': 'error',
  'values-version-unsupported': 'error',
  'variable-declared-unused': 'warning',
  'variable-duplicate': 'error',
  'variable-required-missing': 'error',
  'variable-required-with-default': 'error',
  'variable-undeclared': 'error',
  'variable-unknown-key': 'error',
  'variable-unresolved': 'warning',
})

/** The logical input names that appear in `location.file`. */
export const INPUT_NAMES = Object.freeze(['schema', 'template', 'values'])

class Findings {
  constructor() {
    this.entries = []
  }

  add(ruleId, file, pointer, message, extra = {}) {
    const severity = RULE_SEVERITY[ruleId]
    if (severity === undefined) throw new Error(`No severity is declared for rule "${ruleId}"`)
    if (!INPUT_NAMES.includes(file)) throw new Error(`No such logical input "${file}"`)
    const finding = {
      ruleId,
      severity,
      message: sanitize(message, 400),
      location: { file, ...(pointer === '' ? {} : { pointer: sanitize(pointer, 200) }) },
    }
    if (extra.evidence !== undefined) finding.evidence = sanitize(extra.evidence, 160)
    if (extra.suggestion !== undefined) finding.suggestion = sanitize(extra.suggestion, 240)
    this.entries.push(finding)
    return finding
  }

  /**
   * Sorted by `(location.file, location.pointer, ruleId, message)`.
   *
   * The message is the last tiebreak so that two findings differing only in
   * their message still have one fixed order; without it the pre-sort order,
   * which is emission order, would decide, and emission order is an
   * implementation detail nobody documented.
   */
  sorted() {
    return [...this.entries].sort((left, right) =>
      byCodeUnit(left.location.file, right.location.file)
      || byCodeUnit(left.location.pointer ?? '', right.location.pointer ?? '')
      || byCodeUnit(left.ruleId, right.ruleId)
      || byCodeUnit(left.message, right.message))
  }
}

function validateLimits(overrides) {
  const limits = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new TypeError(`Unknown limit "${key}"`)
    const minimum = key === 'timeoutMs' ? 0 : 1
    if (!Number.isInteger(value) || value < minimum) {
      throw new TypeError(`Limit "${key}" must be an integer of ${minimum} or more`)
    }
    limits[key] = value
  }
  return Object.freeze(limits)
}

/**
 * Read one input, recording the path as a source BEFORE opening it.
 *
 * This tool writes nothing, so the source list is not a write guard here -- it
 * is what the CLI reports as the files it opened, and recording a path only
 * after a successful read would leave out exactly the file that failed.
 */
async function readInput(path, file, maxBytes, findings, sources) {
  sources.push(path)
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    findings.add(`${file}-unreadable`, file, '', `The ${file} could not be read: ${error.code ?? 'unknown error'}.`)
    return { ok: false }
  }
  if (bytes.byteLength > maxBytes) {
    findings.add(
      `${file}-too-large`, file, '',
      `The ${file} is ${bytes.byteLength} bytes, over the ${maxBytes} byte limit.`,
      { suggestion: `Raise --max-${file}-bytes, or split the input.` },
    )
    return { ok: false }
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    findings.add(`${file}-not-utf8`, file, '', `The ${file} is not valid UTF-8, so it was not decoded.`)
    return { ok: false }
  }
  return { ok: true, text: decoded.text }
}

function readJsonInput(text, file, findings) {
  try {
    return { ok: true, document: JSON.parse(text) }
  } catch (error) {
    findings.add(`${file}-not-json`, file, '', `The ${file} is not valid JSON: ${parseFailureDetail(error)}.`)
    return { ok: false }
  }
}

/**
 * Invariants re-checked on every report before it leaves the library.
 *
 * These are not tests; they run in production. They exist because the defect
 * this catalog keeps finding is a `pass` that nobody defended, and an assertion
 * at the exit of the only function that builds a report is the one place that
 * sees every path into it at once.
 */
export function assertReportInvariants(report) {
  const violations = []
  if (report.status === 'pass' && report.summary.checked === 0) {
    violations.push('a pass was produced with nothing checked')
  }
  if (report.status === 'pass' && report.summary.errors > 0) {
    violations.push('a pass was produced with error findings')
  }
  if (report.status === 'incomplete' && report.variables.length > 0) {
    violations.push('an incomplete run produced per-variable verdicts')
  }
  if (report.status !== 'incomplete' && report.summary.unexamined > 0) {
    violations.push('a complete run left variables unexamined')
  }
  for (const finding of report.findings) {
    if (finding.severity !== RULE_SEVERITY[finding.ruleId]) {
      violations.push(`finding "${finding.ruleId}" carries a severity the table does not declare`)
    }
  }
  const faulted = new Set(
    report.findings
      .filter((finding) => finding.severity === 'error')
      .map((finding) => finding.location.pointer ?? ''),
  )
  for (const entry of report.variables) {
    if (entry.verdict === 'ok' && (faulted.has(`/variables/${entry.name}`) || faulted.has(`/values/${entry.name}`))) {
      violations.push(`variable "${entry.name}" was cleared while carrying an error finding`)
    }
    if (entry.required && entry.source === 'none' && entry.verdict === 'ok') {
      violations.push(`required variable "${entry.name}" was cleared with no value`)
    }
  }
  return violations
}

/**
 * Audit a template against its schema and a value set.
 *
 * `monotonic` is injected and defaults to `Date.now`, so a test can step it
 * across the time budget and watch a half-finished audit refuse to report a
 * verdict. No wall clock is read anywhere in this tool and no timestamp reaches
 * the report, which is why two runs over the same inputs are byte-identical
 * whenever they are run.
 */
export async function auditPromptVariablesWithSources(options = {}) {
  const {
    template: templatePath, schema: schemaPath, values: valuesPath,
    limits: limitOverrides = {}, monotonic = Date.now,
  } = options
  for (const [label, value] of [['template', templatePath], ['schema', schemaPath], ['values', valuesPath]]) {
    if (typeof value !== 'string' || value === '') throw new TypeError(`A ${label} path is required`)
  }
  if (typeof monotonic !== 'function') throw new TypeError('"monotonic" must be a function returning milliseconds')
  const limits = validateLimits(limitOverrides)

  const findings = new Findings()
  const sources = []
  const started = monotonic()
  const outOfTime = () => monotonic() - started >= limits.timeoutMs

  const inputs = {
    template: sanitize(basename(templatePath), 120),
    schema: sanitize(basename(schemaPath), 120),
    values: sanitize(basename(valuesPath), 120),
  }

  const finish = (summary, variables) => {
    const emitted = findings.sorted()
    const counts = { errors: 0, warnings: 0, info: 0 }
    for (const finding of emitted) {
      if (finding.severity === 'error') counts.errors += 1
      else if (finding.severity === 'warning') counts.warnings += 1
      else counts.info += 1
    }
    const incomplete = summary.incomplete
    const status = incomplete ? 'incomplete' : (counts.errors > 0 ? 'fail' : 'pass')
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      tool: TOOL_ID,
      status,
      inputs,
      summary: {
        declared: summary.declared,
        used: summary.used,
        // Whatever a caller hands over, an incomplete run publishes no verdicts.
        checked: incomplete ? 0 : variables.length,
        resolved: incomplete ? 0 : variables.filter((entry) => entry.source !== 'none').length,
        stopped: incomplete ? 0 : variables.filter((entry) => entry.verdict === 'stopped').length,
        placeholders: summary.placeholders,
        unexamined: incomplete ? summary.declared + summary.used : 0,
        errors: counts.errors,
        warnings: counts.warnings,
        info: counts.info,
      },
      variables: incomplete ? [] : variables,
      findings: emitted,
    }
    const violations = assertReportInvariants(report)
    if (violations.length > 0) throw new Error(`Report invariant violated: ${violations.join('; ')}`)
    return { report, sources }
  }

  const empty = { declared: 0, used: 0, placeholders: 0, incomplete: true }

  const templateRead = await readInput(templatePath, 'template', limits.maxTemplateBytes, findings, sources)
  const schemaRead = await readInput(schemaPath, 'schema', limits.maxSchemaBytes, findings, sources)
  const valuesRead = await readInput(valuesPath, 'values', limits.maxValuesBytes, findings, sources)
  if (!templateRead.ok || !schemaRead.ok || !valuesRead.ok) return finish(empty, [])

  const schemaJson = readJsonInput(schemaRead.text, 'schema', findings)
  const valuesJson = readJsonInput(valuesRead.text, 'values', findings)
  if (!schemaJson.ok || !valuesJson.ok) return finish(empty, [])

  const schemaDocument = validateSchemaDocument(schemaJson.document)
  for (const entry of schemaDocument.problems) findings.add(entry.ruleId, 'schema', entry.pointer, entry.message)
  const valuesDocument = validateValuesDocument(valuesJson.document)
  for (const entry of valuesDocument.problems) findings.add(entry.ruleId, 'values', entry.pointer, entry.message)

  const declaredCount = Array.isArray(schemaJson.document?.variables) ? schemaJson.document.variables.length : 0
  if (schemaDocument.problems.length > 0 || valuesDocument.problems.length > 0) {
    return finish({ ...empty, declared: declaredCount }, [])
  }
  if (declaredCount > limits.maxVariables) {
    findings.add('too-many-variables', 'schema', '/variables', `The schema declares ${declaredCount} variables, over the ${limits.maxVariables} limit.`)
    return finish({ ...empty, declared: declaredCount }, [])
  }

  const scan = findPlaceholders(templateRead.text)
  for (const entry of scan.problems) {
    findings.add(
      entry.ruleId, 'template', `/offset/${entry.offset}`,
      `A placeholder opens at character ${entry.offset} and is never closed, so everything after it would be `
      + 'interpolated into a placeholder that does not end.',
      { suggestion: 'Close it with }} or escape the opening braces as \\{{.' },
    )
  }
  if (scan.placeholders.length > limits.maxPlaceholders) {
    findings.add('too-many-placeholders', 'template', '', `The template holds ${scan.placeholders.length} placeholders, over the ${limits.maxPlaceholders} limit.`)
    return finish({ ...empty, declared: declaredCount, placeholders: scan.placeholders.length }, [])
  }
  if (scan.problems.length > 0) {
    return finish({ ...empty, declared: declaredCount, placeholders: scan.placeholders.length }, [])
  }

  const ranges = fencedRanges(templateRead.text)
  const usage = new Map()
  for (const placeholder of scan.placeholders) {
    if (!NAME_PATTERN.test(placeholder.name)) {
      findings.add(
        'placeholder-name-invalid', 'template', `/offset/${placeholder.start}`,
        `The placeholder at character ${placeholder.start} reads "${sanitize(placeholder.raw, 64)}", which is not a `
        + `usable variable name (${NAME_PATTERN.source}). Placeholders do not nest: {{ opens one and the first }} `
        + 'closes it, so an inner {{ becomes part of the name.',
        { suggestion: 'Use one placeholder per interpolation, or escape the braces as \\{{.' },
      )
      continue
    }
    const entry = usage.get(placeholder.name) ?? { occurrences: 0, contexts: new Set(), first: placeholder.start }
    entry.occurrences += 1
    entry.contexts.add(contextAt(placeholder.start, ranges))
    usage.set(placeholder.name, entry)
  }

  const declaredByName = new Map(schemaDocument.variables.map((variable) => [variable.name, variable]))
  const names = [...new Set([...declaredByName.keys(), ...usage.keys()])].sort(byCodeUnit)

  /**
   * An audit that checked nothing is not a clean audit.
   *
   * `pass` with `checked: 0` is green on no evidence, and the commonest way to
   * reach it is a `--template` that points at the wrong file. The finding below
   * is a WARNING, so the `incomplete: true` beside it is the only thing standing
   * between this branch and a green exit 0 -- which is why
   * `test/incomplete.test.mjs` removes it and watches the exit code change.
   */
  if (names.length === 0) {
    findings.add(
      'no-variables', 'template', '',
      'The template names no usable variable and the schema declares none, so this run checked nothing '
      + 'and is reported incomplete rather than clean.',
      { suggestion: 'Check that --template and --schema name the intended files.' },
    )
    return finish({ ...empty, declared: declaredCount, placeholders: 0 }, [])
  }

  for (const name of valuesDocument.values.keys()) {
    if (!declaredByName.has(name)) {
      findings.add(
        'value-undeclared', 'values', `/values/${escapePointerSegment(name)}`,
        `A value is supplied for "${sanitize(name, 64)}", which the schema does not declare. It will not be `
        + 'interpolated anywhere.',
        { suggestion: 'Declare it, or remove it -- a value with no declaration is usually a misspelling of one that has.' },
      )
    }
  }

  const variables = []
  for (const name of names) {
    /**
     * Checked BEFORE the variable is audited, not after.
     *
     * A budget noticed after the verdict was appended would leave a cleared
     * variable of record in a run that ran out of time. It is discarded here
     * instead, and the whole run is abandoned: `finish` drops every verdict
     * already made, so no half-audited template can be read as an audited one.
     */
    if (outOfTime()) {
      findings.add(
        'time-budget-exceeded', 'template', '',
        `The ${limits.timeoutMs} ms time budget expired after auditing ${variables.length} of ${names.length} variables, `
        + 'so no verdicts were produced.',
        { suggestion: 'Raise --timeout-ms, or split the template.' },
      )
      return finish({ ...empty, declared: declaredCount, used: usage.size, placeholders: scan.placeholders.length }, variables)
    }

    const declared = declaredByName.get(name)
    const used = usage.get(name)
    const pointer = declared === undefined
      ? `/values/${escapePointerSegment(name)}`
      : `/variables/${escapePointerSegment(name)}`
    let errorsHere = 0
    const fail = (ruleId, file, where, message, extra) => {
      findings.add(ruleId, file, where, message, extra)
      errorsHere += 1
    }

    if (declared === undefined) {
      fail(
        'variable-undeclared', 'template', `/offset/${used.first}`,
        `The template interpolates "${sanitize(name, 64)}", which the schema does not declare, so nothing says `
        + 'what it should contain or what escaping it needs.',
        { suggestion: 'Declare it in the schema, with a context.' },
      )
      variables.push({
        name: sanitize(name, 64),
        declared: false,
        required: false,
        type: null,
        context: null,
        occurrences: used.occurrences,
        contexts: [...used.contexts].sort(byCodeUnit),
        source: 'none',
        verdict: 'stopped',
      })
      continue
    }

    if (used === undefined) {
      findings.add(
        'variable-declared-unused', 'schema', pointer,
        `The schema declares "${sanitize(name, 64)}", which the template never interpolates.`,
        { suggestion: 'Remove the declaration, or interpolate it -- an unused declaration drifts out of date unseen.' },
      )
    } else {
      const contexts = [...used.contexts].sort(byCodeUnit)
      if (contexts.length > 1) {
        fail(
          'context-conflict', 'template', `/offset/${used.first}`,
          `"${sanitize(name, 64)}" is interpolated in more than one context (${contexts.join(' and ')}). `
          + 'One escaping cannot be correct for both, so whichever is declared, one of the sites is wrong.',
          { suggestion: 'Split it into one variable per context.' },
        )
      } else if (INFERRED_CONTEXTS.includes(declared.context) && contexts[0] !== declared.context) {
        fail(
          'context-mismatch', 'schema', pointer,
          `"${sanitize(name, 64)}" is declared as ${declared.context} but every occurrence sits in ${contexts[0]}, `
          + 'so it is checked against the wrong set of characters.',
          { suggestion: `Declare it as ${contexts[0]}, or move the interpolation.` },
        )
      }
    }

    const hasValue = valuesDocument.values.has(name)
    const source = hasValue ? 'value' : (declared.hasDefault ? 'default' : 'none')
    const supplied = hasValue ? valuesDocument.values.get(name) : declared.default
    const suppliedFile = hasValue ? 'values' : 'schema'
    const suppliedPointer = hasValue ? `/values/${escapePointerSegment(name)}` : pointer

    if (source === 'none') {
      if (declared.required) {
        fail(
          'variable-required-missing', 'schema', pointer,
          `"${sanitize(name, 64)}" is declared required and no value was supplied for it.`,
          { suggestion: 'Supply a value, or stop declaring it required.' },
        )
      } else if (used !== undefined) {
        findings.add(
          'variable-unresolved', 'schema', pointer,
          `"${sanitize(name, 64)}" is interpolated but has neither a supplied value nor a default, so the `
          + 'placeholder would render as nothing.',
          { suggestion: 'Give it a default, or supply a value.' },
        )
      }
    } else {
      if (!valueMatchesType(supplied, declared.type)) {
        fail(
          'value-type-mismatch', suppliedFile, suppliedPointer,
          `The ${source} for "${sanitize(name, 64)}" is ${typeOf(supplied)} but the schema declares `
          + `type "${declared.type}".`,
        )
      } else if (typeof supplied === 'string' && supplied.length > limits.maxValueChars) {
        /**
         * A value too long to scan is a value this tool cannot call safe.
         *
         * Reporting it and carrying on would put "no marker was found" next to
         * a value that was never searched. The run is incomplete instead.
         */
        fail(
          'value-too-large', suppliedFile, suppliedPointer,
          `The ${source} for "${sanitize(name, 64)}" is ${supplied.length} characters, over the `
          + `${limits.maxValueChars} character limit, so it was not scanned for markers and cannot be called safe.`,
          { suggestion: 'Raise --max-value-chars, or shorten the value.' },
        )
        return finish({ ...empty, declared: declaredCount, used: usage.size, placeholders: scan.placeholders.length }, variables)
      } else {
        if (carriesPlaceholder(supplied)) {
          fail(
            'value-placeholder-inert', suppliedFile, suppliedPointer,
            `The ${source} for "${sanitize(name, 64)}" itself contains "{{". Interpolation is single-pass: the `
            + 'text is inserted once and never rescanned, so it stays literal rather than expanding.',
            { suggestion: 'Remove the braces, or interpolate the inner variable at the template instead.' },
          )
        }
        const marker = unsafeMarkerFor(supplied, declared.context)
        if (marker !== null) {
          fail(
            'value-unsafe-for-context', suppliedFile, suppliedPointer,
            `The ${source} for "${sanitize(name, 64)}" carries ${sanitize(marker, 80)}, which would break out of `
            + `its declared ${declared.context} context and give inserted data the authority of the template.`,
            {
              evidence: `marker: ${sanitize(marker, 80)}`,
              suggestion: 'Escape it for the context, or reject the input upstream. The auditor never quotes the value itself.',
            },
          )
        }
      }
    }

    variables.push({
      name: sanitize(name, 64),
      declared: true,
      required: declared.required,
      type: declared.type,
      context: declared.context,
      occurrences: used === undefined ? 0 : used.occurrences,
      contexts: used === undefined ? [] : [...used.contexts].sort(byCodeUnit),
      source,
      verdict: errorsHere > 0 ? 'stopped' : 'ok',
    })
  }

  return finish({
    declared: declaredCount, used: usage.size, placeholders: scan.placeholders.length, incomplete: false,
  }, variables)
}

/** The report alone, for the caller who does not need the list of files read. */
export async function auditPromptVariables(options = {}) {
  const { report } = await auditPromptVariablesWithSources(options)
  return report
}

export function formatReport(report) {
  const lines = report.findings.map((finding) =>
    `${finding.severity.toUpperCase().padEnd(7)} ${finding.location.file} ${finding.location.pointer ?? '(document)'} ${finding.ruleId} ${finding.message}`)
  lines.push('')
  for (const entry of report.variables) {
    lines.push(`${entry.verdict.toUpperCase().padEnd(7)} ${entry.name} `
      + `(${entry.declared ? `${entry.type}/${entry.context}` : 'undeclared'}, `
      + `${entry.required ? 'required' : 'optional'}, from ${entry.source}, `
      + `${entry.occurrences} occurrence(s)${entry.contexts.length === 0 ? '' : ` in ${entry.contexts.join(' and ')}`})`)
  }
  if (report.variables.length > 0) lines.push('')
  lines.push(
    `${report.summary.checked} variable(s) checked from ${report.summary.declared} declared and `
    + `${report.summary.used} interpolated across ${report.summary.placeholders} placeholder(s): `
    + `${report.summary.resolved} resolved, ${report.summary.stopped} stopped. `
    + `${report.summary.errors} error, ${report.summary.warnings} warning, ${report.summary.info} info, status ${report.status}.`,
  )
  if (report.status === 'incomplete') {
    lines.push(
      'This run is incomplete, so it produced no verdicts. An incomplete audit is not a clean one.',
    )
  }
  lines.push('No template was rendered and no value was interpolated. This tool reads and reports.')
  return `${lines.join('\n')}\n`
}
