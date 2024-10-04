# prompt-variable-auditor

Audit a prompt template against the schema that declares its variables and the
value set a caller intends to interpolate. Reports placeholders nobody declared,
declarations nobody uses, required variables with no value, defaults that
contradict their own declaration, and values that would break out of the place
they are inserted into.

**It renders nothing.** No template is interpolated, no value is substituted, no
rendered prompt is produced, and no file is written — so there is no step at
which a supplied value could become part of an instruction stream.

- **Repository:** [edilec/prompt-variable-auditor](https://github.com/edilec/prompt-variable-auditor)
- **Area:** Prompt & Agent Workflows
- **License:** MIT

## Why it exists

A prompt template and the code that fills it drift apart quietly. Somebody
renames a field and the placeholder renders as empty text; somebody adds a
placeholder and nothing declares what may go in it; somebody moves an
interpolation inside a fenced code block and the escaping that was right in prose
is now wrong. None of that raises an error at run time — it produces a prompt
that is subtly not the prompt anybody wrote, and the model does something
reasonable with it.

The sharper case is the last one. A value is data, and a value that carries
`\n\nHuman:` or a closing code fence stops being data the moment it is
interpolated: it ends the region it was placed in and whatever follows reads as
the template's own instructions. This tool finds the interpolation points where
that is possible, before a caller builds the prompt.

## Quick start

```sh
# A template whose variables all line up and whose values are all safe. Exits 0.
node bin/prompt-variable-auditor.mjs \
  --template examples/clean/template.md \
  --schema   examples/clean/variables.json \
  --values   examples/clean/values.json

# A required variable with no value, an undeclared placeholder, an unused
# declaration, and three values that break out of their context. Exits 1.
node bin/prompt-variable-auditor.mjs \
  --template examples/unsafe/template.md \
  --schema   examples/unsafe/variables.json \
  --values   examples/unsafe/values.json --json
```

## The placeholder grammar

Written out in full, because "behaves predictably" is not a property a grammar
nobody wrote down can have.

| Written | Means |
| --- | --- |
| `{{name}}` | An interpolation. `{{` opens it and the **first** following `}}` closes it. Scanning is left to right and never recursive. |
| `\{{name}}` | Escaped. Literal text, not an interpolation. |
| `\\{{name}}` | An escaped backslash followed by a **real** placeholder. |
| `{{ {{name}} }}` | **One** placeholder whose name is `{{name`, which is not a usable name and is reported as `placeholder-name-invalid`. The trailing ` }}` is literal. |
| `{{name` | Unterminated, and reported. Scanning stops there. |
| `}}` | With no opening `{{`, literal text. Not reported. |

Backslashes immediately before `{{` are **counted**: an odd number escapes it, an
even number does not. Valid names match `[A-Za-z_][A-Za-z0-9_]{0,63}`. Dots,
dashes and spaces are refused rather than guessed at — `{{a.b}}` invites a reader
to expect a nested lookup this tool does not do.

Placeholders do not nest. That is a limitation, and the table above is exactly
what the limitation looks like from the outside, rather than something you find
out from a wrong prompt.

## The schema

```json
{
  "schemaVersion": "1",
  "variables": [
    { "name": "repository", "type": "string", "required": true, "context": "text" },
    { "name": "focus", "type": "string", "context": "text", "default": "correctness" },
    { "name": "diff", "type": "string", "required": true, "context": "code",
      "description": "free text, never echoed into the report" }
  ]
}
```

| Field | Required | Values |
| --- | --- | --- |
| `name` | yes | `[A-Za-z_][A-Za-z0-9_]{0,63}`, unique in the document |
| `type` | yes | `boolean`, `number`, `string` |
| `context` | yes | `code`, `identifier`, `json-string`, `text` |
| `required` | no | boolean, default `false` |
| `default` | no | must match `type`, and may not be combined with `required` |
| `description` | no | free text, never echoed into the report |

`context` is required on every variable. A variable whose context nobody declared
cannot be checked for what would break out of it, and a check that silently does
not happen is worse than one that is not offered.

`required: true` together with a `default` is refused. A variable with a default
can never be missing, so one of the two declarations is not true and a reader
would take the other for a guarantee.

There is no `object` or `array` type. A template interpolates text, and an object
rendered into a prompt is whatever `String()` makes of it — accepting the
declaration would be promising something this tool cannot check.

## The value set

```json
{ "schemaVersion": "1", "values": { "repository": "edilec/tool", "diff": "..." } }
```

`--values` is **required**. To audit with nothing supplied, pass a file reading
`{"schemaVersion": "1", "values": {}}` — required variables then fail, which is
the point. Making the flag optional would mean a run that never checked
resolution and still came back clean.

## Contexts, and what breaks out of them

Each variable declares a context, and its supplied value — or its default — is
checked for the structural markers that would end that context or open one the
template did not open.

| Context | Refuses |
| --- | --- |
| `text` | `<\|endoftext\|>`, `<\|im_end\|>`, `<\|im_start\|>`, `<</SYS>>`, `<<SYS>>`, `[/INST]`, `[INST]`, `</documents>`, `</function_calls>`, `</instructions>`, `</system>`, `</tool_result>`, `<documents>`, `<function_calls>`, `<instructions>`, `<system>`, `<tool_result>`; plus a conversational turn header (`Human:`, `Assistant:`, `System:`, `User:`) at the start of a line |
| `code` | A fence run of three or more backticks or tildes at the start of a line, which would close the block early |
| `json-string` | A quote, a backslash, or a character below U+0020 — each of which ends the string literal early or is invalid inside one |
| `identifier` | Anything outside `[A-Za-z0-9_-]` |

`text` and `code` are also **inferred** from where the placeholder actually sits:
inside a fenced block it is `code`, otherwise `text`. A declaration that disagrees
with every occurrence is `context-mismatch`, and a variable interpolated in both
is `context-conflict` — one escaping cannot be correct for both, so whichever is
declared, one of the sites is wrong.

`json-string` and `identifier` are **not** inferred. A text template gives nothing
to infer them from, so a declaration of either is taken at its word.

## What the tool guarantees

Each of these has a test that fails when the guarantee is removed from the code.

1. **Escaped and nested placeholders behave as the grammar table says**, and the
   name inside an escaped or nested placeholder never becomes a variable.
2. **A required variable with no value fails.** Not a warning:
   `variable-required-missing` is an error, the status is `fail`, the CLI exits 1.
3. **Interpolation is single-pass, and the audit says so.** A value containing
   `{{other}}` stays literal, `other` never becomes a used variable, and the value
   is reported under `value-placeholder-inert` so the inertness is not mistaken
   for expansion.
4. **A value is never quoted back.** A finding names the **marker** it matched and
   where it was supplied; the value itself never reaches stdout in either output
   mode. Values are the caller's data and may be anything at all.
5. **A value that was not scanned is never reported safe.** A value over
   `--max-value-chars` makes the run `incomplete` rather than passing unchecked.
6. **Unknown evidence is never a pass.** An unreadable, undecodable, unparseable
   or uninterpretable input, a limit reached, a time budget expired, or a template
   and schema that between them name no variable, each produce an `incomplete`
   report with **no per-variable verdicts at all** and exit `2`.
7. **Nothing is rendered and nothing is written.** There is no output flag. The
   shipped source imports none of `node:child_process`, `node:vm`,
   `node:worker_threads` or any network module, uses no `eval`, `new Function` or
   dynamic `import`, and calls no filesystem write.
8. **Output is stable.** Findings and verdicts are ordered by UTF-16 code unit,
   never by locale collation. No clock reading, absolute path or input key order
   reaches stdout.

## Rules

| Rule id | Severity | Meaning |
| --- | --- | --- |
| `context-conflict` | error | One variable is interpolated in more than one context, so no single escaping can be right. |
| `context-mismatch` | error | The declared context disagrees with where every occurrence actually sits. |
| `no-variables` | warning | The template names no usable variable and the schema declares none, so nothing was checked. The run is `incomplete`. |
| `placeholder-name-invalid` | error | A placeholder's name is not usable — commonly a nested `{{`, which becomes part of the name. |
| `placeholder-unterminated` | error | A `{{` is never closed, so everything after it would sit inside a placeholder that does not end. |
| `schema-malformed` | error | The schema is not an object, or a variable declares a field wrongly. |
| `schema-not-json` | error | The schema is not valid JSON. |
| `schema-not-utf8` | error | The schema is not valid UTF-8. |
| `schema-too-large` | error | The schema is over `--max-schema-bytes`. |
| `schema-unreadable` | error | The schema could not be opened. |
| `schema-version-unsupported` | error | The schema declares a `schemaVersion` this release does not read. |
| `template-not-utf8` | error | The template is not valid UTF-8. |
| `template-too-large` | error | The template is over `--max-template-bytes`. |
| `template-unreadable` | error | The template could not be opened. |
| `time-budget-exceeded` | error | `--timeout-ms` expired. No verdicts are produced. |
| `too-many-placeholders` | error | The template holds more placeholders than `--max-placeholders`. |
| `too-many-variables` | error | The schema declares more variables than `--max-variables`. |
| `value-placeholder-inert` | error | A supplied value or default contains `{{`. It is inserted once and never rescanned, so it stays literal. |
| `value-too-large` | error | A value is over `--max-value-chars`, so it was not scanned and cannot be called safe. |
| `value-type-mismatch` | error | A supplied value or default is not of the declared type. |
| `value-undeclared` | warning | A value is supplied for a variable the schema does not declare. It is interpolated nowhere. |
| `value-unsafe-for-context` | error | A supplied value or default carries a marker that breaks out of its declared context. |
| `values-malformed` | error | The value set is not an object, or `values` is not an object. |
| `values-not-json` | error | The value set is not valid JSON. |
| `values-not-utf8` | error | The value set is not valid UTF-8. |
| `values-too-large` | error | The value set is over `--max-values-bytes`. |
| `values-unreadable` | error | The value set could not be opened. |
| `values-version-unsupported` | error | The value set declares a `schemaVersion` this release does not read. |
| `variable-declared-unused` | warning | The schema declares a variable the template never interpolates. |
| `variable-duplicate` | error | The schema declares the same name more than once. |
| `variable-required-missing` | error | A required variable has no supplied value. |
| `variable-required-with-default` | error | A variable is declared required and carries a default, which cannot both be true. |
| `variable-undeclared` | error | The template interpolates a variable the schema does not declare. |
| `variable-unknown-key` | error | A variable declares a key this schema does not define — usually a typo that would otherwise be ignored. |
| `variable-unresolved` | warning | A variable is interpolated with neither a value nor a default, so the placeholder renders as nothing. |

Rule ids are stable across releases; renaming one is a breaking change recorded
in [CHANGELOG.md](./CHANGELOG.md).

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| `0` | every variable lines up and every value is safe for its context | the report |
| `1` | at least one variable is stopped | the report |
| `2` | invalid usage | **empty** |
| `2` | evidence missing, undecodable or bounded out | an `incomplete` report |

Exit 2 has two shapes on purpose. A usage error means the run never had a
subject, so there is nothing to report about. An unreadable input means the run
had a subject and failed to obtain evidence about it — which is what `incomplete`
exists to say, and a consumer needs that report to know *which* input was not
read. A consumer piping stdout must handle an empty stdout on exit 2.

## Determinism

Running the tool twice over identical inputs produces byte-identical stdout, on
any machine at any moment.

- Findings sort by `(location.file, location.pointer, ruleId, message)`, verdicts
  by variable name, and the contexts listed on a verdict — all by **UTF-16 code
  unit**. `localeCompare` and `Intl.Collator` consult ICU data that differs
  between Node builds, so two correct machines would disagree about the same
  report.
- `location.file` is the **logical input name**, `template`, `schema` or `values`
  — never a host path. `location.pointer` addresses a variable by name
  (`/variables/focus`, `/values/focus`) and a template position by character
  offset (`/offset/167`).
- No wall clock is read anywhere. The only injected clock measures the time
  budget and never reaches the report.

## Limits

Every limit is enforced and overridable. Exceeding one is an `incomplete` result
naming the limit, never a silent truncation and never a pass.

| Flag | Default |
| --- | ---: |
| `--max-placeholders` | 2000 |
| `--max-schema-bytes` | 1048576 |
| `--max-template-bytes` | 1048576 |
| `--max-value-chars` | 65536 |
| `--max-values-bytes` | 1048576 |
| `--max-variables` | 500 |
| `--timeout-ms` | 10000 |

`--timeout-ms 0` leaves no time at all and the first check fires. That is the only
way to prove from outside that the flag reaches the audit loop.

## Non-goals

- **It does not render.** There is no `--out`, no rendered prompt, and no
  substitution step anywhere in the tool.
- **It does not detect natural-language prompt injection.** `Ignore all previous
  instructions` is not flagged and never will be by this tool. Only the
  structural markers in the table above are matched. A list of English phrases
  would look like a guarantee and would not be one — the first paraphrase walks
  through it.
- **It does not infer `json-string` or `identifier` contexts.** A text template
  gives nothing to infer them from; a declaration of either is taken at its word.
- **It does not understand any templating engine.** Not Jinja, not Handlebars,
  not Mustache: `{{name}}` with the grammar above, and nothing else. There are no
  filters, no conditionals, no loops and no partials.
- **It does not do nested lookups.** `{{a.b}}` is an invalid name, not a path.
- **It does not check that a value is *correct*** — only that it is of the
  declared type and that it does not break out of its declared context.
- **No network access, ever, including in tests.**

## Verification

```sh
npm run check   # lint + tests + both examples + npm pack --dry-run
```

## License

MIT. See [LICENSE](./LICENSE).
