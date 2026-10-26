// @ts-check
// Checks the token file: the two dark blocks must match, and text and meaning colors must reach
// WCAG 2.x AA contrast (4.5:1) on the surfaces they are drawn on. No dependencies.
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import contrast from '../../src/shared/contrast-pairs.json' with { type: 'json' }

// The app checks installed themes against the same pairs.
export const MIN_RATIO = contrast.minRatio

/**
 * Foreground tokens and the background tokens each is drawn on, in both themes. The last two are
 * inverted fills: the send button's icon, tooltips, and a count on the attention fill.
 */
export const PAIR_GROUPS = contrast.groups

export const PAIRS = PAIR_GROUPS.flatMap(({ fg, on }) => on.map((bg) => ({ fg, bg })))

/** Disabled controls are exempt from contrast by WCAG, and the design keeps them faint. */
export const EXEMPT = contrast.exempt

/** @typedef {Map<string, string>} Declarations custom property name to value, trimmed */
/** @typedef {{ light: Declarations, mediaDark: Declarations, dark: Declarations }} Blocks */

const blank = (/** @type {string} */ text) => text.replace(/[^\n]/g, ' ')
const normalizeSelector = (/** @type {string} */ selector) =>
  selector.replace(/\s+/g, ' ').replace(/"/g, "'").trim()
const normalizeValue = (/** @type {string} */ value) => value.replace(/\s+/g, ' ').trim()

/**
 * @param {string} css
 * @param {string | null} atRule
 * @returns {{ selector: string, atRule: string | null, declarations: Declarations }[]}
 */
function parseRules(css, atRule = null) {
  /** @type {{ selector: string, atRule: string | null, declarations: Declarations }[]} */
  const rules = []
  let position = 0
  for (;;) {
    const open = css.indexOf('{', position)
    if (open === -1) return rules
    let depth = 1
    let close = open + 1
    for (; close < css.length && depth > 0; close++) {
      if (css[close] === '{') depth++
      else if (css[close] === '}') depth--
    }
    const prelude = css.slice(position, open).trim()
    const body = css.slice(open + 1, close - 1)
    if (prelude.startsWith('@')) {
      rules.push(...parseRules(body, normalizeSelector(prelude)))
    } else {
      /** @type {Declarations} */
      const declarations = new Map()
      for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
        declarations.set(m[1], normalizeValue(m[2]))
      }
      rules.push({ selector: normalizeSelector(prelude), atRule, declarations })
    }
    position = close
  }
}

/**
 * Reads the three blocks of the token file: the light rule on `:root`, the dark rule under
 * `prefers-color-scheme: dark`, and the `[data-theme='dark']` rule.
 *
 * @param {string} css
 * @returns {Blocks}
 */
export function parseTokens(css) {
  const rules = parseRules(css.replace(/\/\*[\s\S]*?\*\//g, blank))
  /** @param {string} name @param {string | null} atRule @param {string} selector */
  const find = (name, atRule, selector) => {
    const rule = rules.find((r) => r.atRule === atRule && r.selector === selector)
    if (!rule) throw new Error(`The ${name} block is missing: ${atRule ?? ''} ${selector}`.trim())
    return rule.declarations
  }
  return {
    light: find('light', null, ":root, [data-theme='light']"),
    mediaDark: find(
      'media-dark',
      '@media (prefers-color-scheme: dark)',
      ":root:not([data-theme='light'])",
    ),
    dark: find('dark', null, "[data-theme='dark']"),
  }
}

/**
 * @param {Declarations} a
 * @param {Declarations} b
 * @returns {string[]} one problem per property that is missing from a side or differs
 */
export function compareDarkBlocks(a, b) {
  /** @type {string[]} */
  const problems = []
  for (const [name, value] of a) {
    const other = b.get(name)
    if (other === undefined) problems.push(`${name} is missing from the [data-theme='dark'] block`)
    else if (other !== value)
      problems.push(`${name} differs: media dark '${value}', dark '${other}'`)
  }
  for (const name of b.keys()) {
    if (!a.has(name)) problems.push(`${name} is missing from the media dark block`)
  }
  return problems
}

/**
 * Reads an opaque sRGB color: a hex color or `rgb()` without alpha. Anything else (alpha, oklch,
 * var()) returns null.
 *
 * @param {string} value
 * @returns {[number, number, number] | null} channels from 0 to 255
 */
export function parseColor(value) {
  const text = value.trim().toLowerCase()
  const hex = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/.exec(text)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex
    if (full.length === 8 && full.slice(6) !== 'ff') return null
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
    return [r, g, b]
  }
  const rgb = /^rgb\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*\)$/.exec(text)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return null
}

/** @param {[number, number, number]} rgb WCAG 2.x relative luminance */
export function luminance([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}

/** @param {[number, number, number]} a @param {[number, number, number]} b */
export function contrastRatio(a, b) {
  const [la, lb] = [luminance(a), luminance(b)]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * @typedef {object} Row
 * @property {'light' | 'dark'} theme
 * @property {string} fg
 * @property {string} bg
 * @property {number | null} ratio null when a color could not be resolved
 * @property {boolean} ok
 * @property {string} [note] why the pair is skipped or failed outright
 */

/**
 * Checks every pair in both themes. The dark theme is the light block with the dark block on top.
 *
 * @param {Blocks} blocks
 * @param {{ fg: string, bg: string }[]} [pairs]
 * @returns {Row[]}
 */
export function checkContrast(blocks, pairs = PAIRS) {
  /** @type {Row[]} */
  const rows = []
  const themes = /** @type {const} */ ([
    ['light', blocks.light],
    ['dark', new Map([...blocks.light, ...blocks.dark])],
  ])
  for (const [theme, tokens] of themes) {
    for (const { fg, bg } of pairs) {
      const values = [fg, bg].map((name) => tokens.get(name))
      const missing = [fg, bg].filter((_, i) => values[i] === undefined)
      if (missing.length > 0) {
        rows.push({ theme, fg, bg, ratio: null, ok: false, note: `missing ${missing.join(', ')}` })
        continue
      }
      const [fgColor, bgColor] = values.map((value) => parseColor(/** @type {string} */ (value)))
      if (!fgColor || !bgColor) {
        rows.push({ theme, fg, bg, ratio: null, ok: true, note: 'skipped: not an opaque color' })
        continue
      }
      const ratio = contrastRatio(fgColor, bgColor)
      rows.push({ theme, fg, bg, ratio, ok: ratio >= MIN_RATIO })
    }
  }
  return rows
}

/** Truncates, never rounds up, so a ratio shown as 4.50 really passes. */
export const formatRatio = (/** @type {number} */ ratio) =>
  (Math.floor(ratio * 100) / 100).toFixed(2)

/** @param {Row[]} rows @returns {string[]} an aligned table, one line per row */
export function formatTable(rows) {
  const width = (/** @type {(row: Row) => string} */ pick) =>
    Math.max(...rows.map((r) => pick(r).length))
  const [wFg, wBg] = [width((r) => r.fg), width((r) => r.bg)]
  return [
    `${'theme'.padEnd(5)}  ${'fg'.padEnd(wFg)}  ${'bg'.padEnd(wBg)}  ${'ratio'.padStart(5)}  ok`,
    ...rows.map((r) => {
      const ratio = r.ratio === null ? '-' : formatRatio(r.ratio)
      const state = r.note?.startsWith('skipped') ? 'skip' : r.ok ? 'ok' : 'FAIL'
      return `${r.theme.padEnd(5)}  ${r.fg.padEnd(wFg)}  ${r.bg.padEnd(wBg)}  ${ratio.padStart(5)}  ${state}`
    }),
  ]
}

/**
 * Everything the check can fail on, for a token file's text.
 *
 * @param {string} css
 * @returns {{ rows: Row[], problems: string[] }}
 */
export function checkTokens(css) {
  const blocks = parseTokens(css)
  const rows = checkContrast(blocks)
  const problems = compareDarkBlocks(blocks.mediaDark, blocks.dark).map(
    (problem) => `dark blocks: ${problem}`,
  )
  for (const row of rows) {
    if (row.ok) continue
    problems.push(
      row.ratio === null
        ? `${row.theme}: ${row.fg} on ${row.bg}: ${row.note}`
        : `${row.theme}: ${row.fg} on ${row.bg} is ${formatRatio(row.ratio)}:1, below ${MIN_RATIO}:1`,
    )
  }
  return { rows, problems }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const file =
    args.find((arg) => !arg.startsWith('--')) ??
    fileURLToPath(new URL('../../src/renderer/src/styles/tokens.css', import.meta.url))
  const { rows, problems } = checkTokens(readFileSync(file, 'utf8'))
  if (args.includes('--table')) console.log(formatTable(rows).join('\n'))
  for (const problem of problems) console.log(problem)
  const skipped = rows.filter((row) => row.ratio === null && row.ok).length
  console.log(
    `contrast: ${rows.length} pairs, ${problems.length} problems` +
      (skipped > 0 ? `, ${skipped} skipped (not opaque)` : '') +
      `; ${EXEMPT.join(', ')} exempt (disabled)`,
  )
  if (problems.length > 0) process.exitCode = 1
}
