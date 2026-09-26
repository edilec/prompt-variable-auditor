/**
 * The template scanner: what a placeholder is, where it sits, and what would
 * break out of the place it sits in.
 *
 * Every function here is a pure function of its arguments. Nothing is read from
 * the filesystem, the clock, the locale or the environment, and nothing is
 * rendered: this module finds interpolation points and never performs one.
 */

/**
 * A usable variable name.
 *
 * Deliberately narrow. Dots, dashes and spaces are all plausible and all
 * ambiguous -- `{{a.b}}` invites a reader to expect a nested lookup this tool
 * does not do -- so a name outside this shape is reported rather than guessed
 * at.
 */
export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** The contexts a variable can declare, and the contexts this tool can infer. */
export const CONTEXTS = Object.freeze(['code', 'identifier', 'json-string', 'text'])
export const INFERRED_CONTEXTS = Object.freeze(['code', 'text'])

/**
 * Structural markers that would give inserted data the authority of the
 * template around it.
 *
 * These are STRUCTURAL, not semantic. Each one either ends the region the value
 * was inserted into or opens a region the surrounding prompt did not open.
 * Recognising `Ignore all previous instructions` is NOT attempted and is a
 * stated non-goal: a list of English phrases would be a filter that looks like a
 * guarantee, and the first paraphrase walks through it.
 */
export const TEXT_MARKERS = Object.freeze([
  '<|endoftext|>', '<|im_end|>', '<|im_start|>',
  '<</SYS>>', '<<SYS>>', '[/INST]', '[INST]',
  '</documents>', '</function_calls>', '</instructions>', '</system>', '</tool_result>',
  '<documents>', '<function_calls>', '<instructions>', '<system>', '<tool_result>',
])

/**
 * A conversational turn header at the start of a line.
 *
 * `\n\nHuman:` is the classic: a value carrying it ends the turn it was
 * inserted into and opens one the template never wrote. Anchored to a line
 * start, so an ordinary sentence mentioning a system is not flagged.
 */
export const TURN_HEADER = /(?:^|\n)[ \t]*(?:Assistant|Human|System|User)[ \t]*:/

/** A fence run long enough to close a fenced block. */
const FENCE_RUN = /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})/

/** Anything outside this set breaks an identifier out of its own token. */
const IDENTIFIER_SAFE = /^[A-Za-z0-9_-]*$/

/**
 * Anything that would end a JSON string literal early, or is illegal inside
 * one. A raw control character below U+0020 is invalid JSON, not merely ugly.
 */
const JSON_STRING_BREAKERS = new RegExp(`["\\\\${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}]`)

/**
 * Find every interpolation point, with its offset and its raw name.
 *
 * The grammar, written out because "behaves predictably" is an acceptance
 * criterion and a grammar nobody wrote down cannot be predictable:
 *
 * - `{{` opens a placeholder and the FIRST following `}}` closes it. Scanning
 *   is left to right and NEVER recursive.
 * - Backslashes immediately before `{{` are counted. An ODD number escapes it:
 *   `\{{x}}` is literal text. An EVEN number does not: `\\{{x}}` is a real
 *   placeholder preceded by an escaped backslash.
 * - `{{ {{x}} }}` therefore yields ONE placeholder whose raw name is `{{x`,
 *   which is not a usable name and is reported as such. The trailing ` }}` is
 *   literal. Nesting is not supported, and this is what not supporting it looks
 *   like from the outside.
 * - `{{` with no `}}` after it is unterminated and is reported. Scanning stops
 *   there, because everything after it is inside a placeholder that never ends.
 * - A `}}` with no opening is literal text and is not reported.
 */
export function findPlaceholders(text) {
  const placeholders = []
  const problems = []
  let index = 0
  while (index < text.length) {
    const open = text.indexOf('{{', index)
    if (open === -1) break
    let backslashes = 0
    for (let back = open - 1; back >= 0 && text[back] === '\\'; back -= 1) backslashes += 1
    if (backslashes % 2 === 1) {
      index = open + 2
      continue
    }
    const close = text.indexOf('}}', open + 2)
    if (close === -1) {
      problems.push({ ruleId: 'placeholder-unterminated', offset: open })
      break
    }
    const raw = text.slice(open + 2, close)
    placeholders.push({ raw, name: raw.trim(), start: open, end: close + 2 })
    index = close + 2
  }
  return { placeholders, problems }
}

/**
 * The half-open character ranges that sit inside a fenced code block.
 *
 * A fence line itself is not inside the block it opens or closes. An
 * unterminated fence runs to the end of the template, which is what a consumer
 * of the rendered prompt would also see.
 */
export function fencedRanges(text) {
  const ranges = []
  let offset = 0
  let openMarker = null
  let openedAt = 0
  for (const line of text.split('\n')) {
    const lineEnd = offset + line.length
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      const marker = fence[1][0]
      if (openMarker === null) {
        openMarker = marker
        openedAt = Math.min(lineEnd + 1, text.length)
      } else if (marker === openMarker) {
        ranges.push([openedAt, offset])
        openMarker = null
      }
    }
    offset = lineEnd + 1
  }
  if (openMarker !== null) ranges.push([openedAt, text.length])
  return ranges
}

/** `code` when the offset sits inside a fenced block, `text` otherwise. */
export function contextAt(offset, ranges) {
  for (const [from, to] of ranges) {
    if (offset >= from && offset < to) return 'code'
  }
  return 'text'
}

/**
 * Which structural marker a value carries for a given context, or null.
 *
 * The marker NAME is returned, never the value. A value is the caller's data
 * and may be anything at all -- a customer record, a key, a whole document --
 * so the report says which marker matched and where, and never quotes what
 * surrounded it.
 */
export function unsafeMarkerFor(value, context) {
  if (typeof value !== 'string') return null
  if (context === 'identifier') {
    return IDENTIFIER_SAFE.test(value) ? null : 'a character outside [A-Za-z0-9_-]'
  }
  if (context === 'json-string') {
    return JSON_STRING_BREAKERS.test(value)
      ? 'a quote, backslash or control character that ends the string literal early'
      : null
  }
  if (context === 'code') {
    return FENCE_RUN.test(`\n${value}`) ? 'a fence run that closes the code block early' : null
  }
  for (const marker of TEXT_MARKERS) {
    if (value.includes(marker)) return marker
  }
  return TURN_HEADER.test(value) ? 'a conversational turn header at the start of a line' : null
}

/** Does this value carry text that looks like a placeholder of its own? */
export function carriesPlaceholder(value) {
  return typeof value === 'string' && value.includes('{{')
}
