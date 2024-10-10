# Changelog

All notable changes to this project are documented here. Rule ids are part of
the public surface: renaming one is a breaking change and is recorded here.

## 0.1.0

First implementation.

- Extracts placeholders under a written-down grammar: `{{` opens and the first
  `}}` closes, backslashes are counted so an odd number escapes, placeholders do
  not nest, and an unterminated one stops the scan.
- Compares the template against a variable schema and a supplied value set, and
  reports undeclared placeholders, unused declarations, duplicates, type
  mismatches, required variables with no value, and optional ones that would
  render as nothing.
- Checks each supplied value and each default against its declared context for
  the structural markers that would break out of it: role and turn markers in
  prose, a fence run in a code block, a quote or control character in a JSON
  string literal, and anything outside `[A-Za-z0-9_-]` in an identifier. The
  finding names the marker; the value itself never reaches the report.
- Infers the `text` and `code` contexts from where a placeholder sits, and
  reports a declaration that disagrees with every occurrence, or a variable
  interpolated in both.
- Interpolation is single-pass and the audit says so: a value containing `{{`
  is reported as inert rather than expanded.
- An incomplete run — unreadable, undecodable, unparseable or uninterpretable
  input, a limit reached, a value too long to scan, a time budget expired, or a
  template and schema that between them name no variable — produces no
  per-variable verdicts at all and exits 2.
- A document value that cannot be turned into a string — an object carrying a
  non-callable `toString` — is described by its shape (`[object]`, `[array]`)
  and the input is reported as uninterpretable. It never aborts the run, and it
  never suppresses the findings for the other inputs.
- Renders nothing and writes nothing. There is no output flag.
- 35 rule ids, listed in [README.md](./README.md).
