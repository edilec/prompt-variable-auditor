# Design notes

## The grammar is the product

Most of what goes wrong with a prompt template goes wrong at the edges of the
placeholder syntax, not in the middle of it. So the grammar is written down in
three places that must agree — the README table, `--help`, and
`test/template.test.mjs` — and the test is the one that decides.

`{{ {{name}} }}` is the case worth dwelling on. A tool could reasonably support
nesting, refuse it loudly, or do what this one does: scan left to right, let the
first `}}` close the placeholder, and report the resulting name as unusable. The
third is the least clever and the most predictable, and the table says exactly
what it produces. What would not be acceptable is silently extracting `name` and
leaving the outer braces in the rendered prompt, which is what a naive regex
does.

Backslash counting matters for the same reason. `\{{x}}` is literal and
`\\{{x}}` is not, because a template that ends a line with a Windows path should
not accidentally disarm the placeholder after it.

## Two contexts are inferred and two are not

`text` and `code` can be read off the template: a placeholder is either inside a
fenced block or it is not. `json-string` and `identifier` cannot — a Markdown
template gives nothing to infer them from — so they are taken at their word.

That asymmetry is documented rather than smoothed over. Inferring a context
badly is worse than not inferring it: a `context-mismatch` that fires on a
correct declaration trains a reader to ignore the rule, and a rule people ignore
is a rule that is not there.

`context-conflict` is the rule this model exists for. A variable interpolated
once in prose and once in a code fence cannot be escaped correctly for both, and
no amount of care at the call site fixes it — the template has to change. It is
an error, not a warning, because the alternative is a value that is safe in one
of the two places it appears.

## Structural markers, and the detector that is not offered

The safety check matches a fixed list of structural markers and a line-anchored
turn header. It does not look for `Ignore all previous instructions`, and the
README says so twice.

The reason is that a phrase list is a filter that reads as a guarantee. Every
paraphrase walks through it, and the first person to see the rule in a rule table
stops writing the review step that would actually have caught it. A structural
marker is different in kind: `\n\nHuman:` inside a value does not *suggest*
anything to a model, it ends the turn. That is a property of the text, it is
decidable, and a check for it is either right or wrong rather than approximate.

## The value never reaches the report

A supplied value may be a customer record, a diff, a key, a whole document.
Quoting it into a finding would put it into stdout, into CI logs, and into
whatever pastes the report into a review comment.

So a finding names the MARKER it matched — `<|im_start|>`, or "a conversational
turn header at the start of a line" — and where the value came from, and nothing
else. `test/acceptance.test.mjs` plants a credential beside a marker and asserts
it appears nowhere in either output mode.

The same reasoning produced `value-too-large`. A value longer than the scan
limit is not scanned, and a value that was not scanned cannot be reported safe,
so the run is incomplete rather than quietly clean.

## Why `--values` is required

An optional value set would mean a mode in which resolution is not checked, and
that mode would come back clean on a template with three required variables. It
would also be the default, because a flag people can leave out is a flag people
leave out.

Requiring it costs one file containing `{"schemaVersion": "1", "values": {}}`,
and buys an audit where "required variables without values fail" is true of
every run rather than of the runs that remembered.

## What was left out

- **Rendering.** No `--out`, no substitution, no rendered prompt. The tool has
  no destination to guard because it has no destination.
- **Templating engines.** No filters, conditionals, loops or partials. Adding
  any of them makes the grammar table above stop being complete, and the grammar
  table is the product.
- **Nested lookups.** `{{a.b}}` is an invalid name rather than a path, because a
  path implies a resolution step this tool does not perform and could not check.
- **Object and array types.** What `String()` makes of an object is not
  something a schema can promise.
