// @ts-check
// Finds color literals in text, for the rule that keeps colors in the token file. No dependencies.

export const TOKEN_FILE = 'src/renderer/src/styles/tokens.css'

/** @param {string} match */
export const colorLiteralMessage = (match) =>
  `Color literal '${match}': colors live in ${TOKEN_FILE}`

// Every CSS named color except transparent and the keywords (currentcolor, inherit, ...).
const NAMED_COLORS = `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond
blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson
cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta
darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray
darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick
floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey
honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon
lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink
lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow
lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple
mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue
mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue
purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna
silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato
turquoise violet wheat white whitesmoke yellow yellowgreen`.split(/\s+/)

const HUES = [
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue',
  'indigo|violet|purple|fuchsia|pink|rose',
].join('|')

const UTILITIES = [
  'bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|inset-ring|outline|fill|stroke|from|via|to',
  'shadow|inset-shadow|drop-shadow|decoration|divide|accent|caret|placeholder',
].join('|')

// A hex color needs a separator before it, so `#root`, `a#b` and `#${id}` are not colors; it is
// still a guess for 3-digit text like `PR #123`, which an eslint-disable comment can settle.
const HEX_BODY = '#(?:[\\da-f]{8}|[\\da-f]{6}|[\\da-f]{4}|[\\da-f]{3})(?![\\w-])'
const HEX = new RegExp(`(?<![^\\s[(,:_=])${HEX_BODY}`, 'gi')
const HEX_IN_MARKUP = new RegExp(`(?<![^\\s[(,:_="'])${HEX_BODY}`, 'gi')

// Underscores stand for spaces in Tailwind arbitrary values, so `_rgb(` counts as a call. Bare
// `color(` is common prose and only counts when a color space follows.
const FUNCTION = new RegExp(
  '(?<![a-z\\d-])(?:(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\\(|color\\((?=[\\s_]*' +
    '(?:from|srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65)\\b))',
  'gi',
)

const PALETTE = new RegExp(
  `(?<![\\w-])(?:${UTILITIES})-(?:(?:${HUES})-(?:50|100|200|300|400|500|600|700|800|900|950)|black|white)` +
    '(?:/(?:\\d+|\\[[^\\]]*\\]|\\([^)]*\\)))?(?![\\w-])',
  'g',
)

const NAMED = new RegExp(`(?<![\\w-])(?:${NAMED_COLORS.join('|')})(?![\\w(-])`, 'gi')

/** @param {string} valueChars the characters a property's value may contain */
const colorProperty = (valueChars) =>
  new RegExp(
    '(?<![\\w-])(?:color|background(?:-color)?|' +
      'border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|' +
      'outline(?:-color)?|fill|stroke|box-shadow|text-decoration(?:-color)?|caret-color|' +
      `accent-color|column-rule(?:-color)?|scrollbar-color)\\s*:\\s*(${valueChars}*)`,
    'gi',
  )
const COLOR_PROPERTY = colorProperty('[^;{}]')
// In markup a value also ends at the attribute's closing quote or the next tag.
const COLOR_PROPERTY_IN_MARKUP = colorProperty('[^;{}"\'<>]')
// A custom property that is nothing but a color name.
const CUSTOM_PROPERTY_NAME = /(?<![\w-])--[\w-]+\s*:\s*([a-z]+)\s*(?:!important)?\s*(?=[;}]|$)/gi
// SVG presentation attributes.
const COLOR_ATTRIBUTE =
  /(?<![\w-])(?:fill|stroke|stop-color|flood-color|lighting-color|color)\s*=\s*(["'])(.*?)\1/gis

/** @param {string} text */
const blank = (text) => text.replace(/[^\n]/g, ' ')

/** @param {string} text @param {boolean} markup */
function stripComments(text, markup) {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, blank)
  return markup ? css.replace(/<!--[\s\S]*?-->/g, blank) : css
}

/** Hides what a color name can appear in without being a color: url() and quoted strings. */
function maskValue(/** @type {string} */ value) {
  return value.replace(/url\([^)]*\)|"[^"]*"|'[^']*'/gi, blank)
}

/**
 * @param {string} before the text up to the hex color
 * @param {{ css: boolean, markup: boolean }} mode
 */
function isHexColorContext(before, mode) {
  if (/url\(\s*["']?$/i.test(before)) return false
  if (mode.markup) return !/\bhref\s*=\s*["']$/i.test(before)
  if (!mode.css) return true
  // In a stylesheet, `#add {` is a selector: a color follows a colon or an @apply.
  const statement = before.slice(
    Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('}')) + 1,
  )
  return statement.includes(':') || /^\s*@/.test(statement)
}

/**
 * Finds the colors written out in `text`: hex colors, color functions and Tailwind palette
 * utilities, plus CSS named colors in color properties when `css` is set. `markup` is for HTML and
 * SVG files and also reads quoted hex values and color attributes.
 *
 * @param {string} text
 * @param {{ css?: boolean, markup?: boolean }} [options]
 * @returns {{ index: number, match: string, kind: 'hex' | 'function' | 'palette' | 'named' }[]}
 */
export function findColorLiterals(text, options = {}) {
  const markup = options.markup === true
  const css = options.css === true || markup
  const source = css ? stripComments(text, markup) : text
  /** @type {{ index: number, match: string, kind: 'hex' | 'function' | 'palette' | 'named' }[]} */
  const found = []

  for (const m of source.matchAll(markup ? HEX_IN_MARKUP : HEX)) {
    if (isHexColorContext(source.slice(0, m.index), { css, markup })) {
      found.push({ index: m.index, match: m[0], kind: 'hex' })
    }
  }
  for (const m of source.matchAll(FUNCTION)) {
    found.push({ index: m.index, match: m[0], kind: 'function' })
  }
  for (const m of source.matchAll(PALETTE)) {
    found.push({ index: m.index, match: m[0], kind: 'palette' })
  }

  if (css) {
    /** @type {{ start: number, value: string }[]} */
    const values = []
    for (const m of source.matchAll(markup ? COLOR_PROPERTY_IN_MARKUP : COLOR_PROPERTY)) {
      values.push({ start: m.index + m[0].length - m[1].length, value: m[1] })
    }
    for (const m of source.matchAll(CUSTOM_PROPERTY_NAME)) {
      values.push({ start: m.index + m[0].indexOf(m[1], m[0].indexOf(':')), value: m[1] })
    }
    if (markup) {
      for (const m of source.matchAll(COLOR_ATTRIBUTE)) {
        values.push({ start: m.index + m[0].lastIndexOf(m[2]), value: m[2] })
      }
    }
    const seen = new Set()
    for (const { start, value } of values) {
      for (const m of maskValue(value).matchAll(NAMED)) {
        const index = start + m.index
        if (seen.has(index)) continue
        seen.add(index)
        found.push({ index, match: m[0], kind: 'named' })
      }
    }
  }

  return found.sort((a, b) => a.index - b.index)
}
