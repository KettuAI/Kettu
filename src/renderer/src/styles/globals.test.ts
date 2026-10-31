import { describe, expect, it } from 'vitest'
import css from './globals.css?raw'

// The text between the braces of every block that opens after `header`.
function blocksAfter(header: string): string[] {
  const blocks: string[] = []
  for (let from = css.indexOf(header); from >= 0; from = css.indexOf(header, from + 1)) {
    const open = css.indexOf('{', from)
    let depth = 0
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}' && --depth === 0) {
        blocks.push(css.slice(open + 1, i))
        break
      }
    }
  }
  return blocks
}

// The selectors of the rule in `block` that sets `animation: none`, without nesting prefixes.
function stoppedSelectors(block: string): string[] {
  const rule = /([^{}]+)\{[^{}]*animation:\s*none\s*!important[^{}]*\}/.exec(block)
  expect(rule, 'no rule stops animations').not.toBeNull()
  return rule![1].split(',').map((selector) => selector.trim().replace(/^&\s*/, ''))
}

// The two places that turn reduce motion on: the OS setting and Settings > Appearance.
const osBlocks = blocksAfter('@media (prefers-reduced-motion: reduce)').filter((block) =>
  block.includes('animation: none'),
)
const settingBlocks = blocksAfter(":root[data-reduce-motion='always']")

describe('reduce motion in globals.css', () => {
  it('has one block for the OS setting and one for the Settings override', () => {
    expect(osBlocks).toHaveLength(1)
    expect(settingBlocks).toHaveLength(1)
  })

  it.each([
    ['the OS setting', osBlocks],
    ['the Settings override', settingBlocks],
  ])('holds looping animations still under %s', (_name, blocks) => {
    // Spinners and pulses loop forever, so they must stop; one-shot animations may play.
    expect(stoppedSelectors(blocks[0])).toEqual(
      expect.arrayContaining(['.animate-spin', '.animate-pulse']),
    )
  })

  it('stops the same loops in both blocks', () => {
    expect(stoppedSelectors(settingBlocks[0])).toEqual(stoppedSelectors(osBlocks[0]))
  })
})

// The declarations of the one block after `header`, without its nested rules and comments.
function declarationsAfter(header: string): Map<string, string> {
  const blocks = blocksAfter(header)
  expect(blocks, `one block after ${header}`).toHaveLength(1)
  return declarations(blocks[0])
}

// The declarations of a rule nested in the one block after `header`.
function nestedDeclarationsAfter(header: string, selector: string): Map<string, string> {
  const block = blocksAfter(header)[0]
  const at = block.indexOf(`& ${selector} {`)
  expect(at, `${selector} in ${header}`).toBeGreaterThanOrEqual(0)
  const open = block.indexOf('{', at)
  let depth = 0
  for (let i = open; i < block.length; i++) {
    if (block[i] === '{') depth++
    else if (block[i] === '}' && --depth === 0) return declarations(block.slice(open + 1, i))
  }
  throw new Error(`unclosed rule for ${selector}`)
}

function declarations(block: string): Map<string, string> {
  const found = new Map<string, string>()
  let depth = 0
  let text = ''
  for (const char of block.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (char === '{') {
      // What came before a nested block is its selector.
      if (depth++ === 0) text = ''
    } else if (char === '}') depth--
    else if (depth > 0) continue
    else if (char === ';') {
      const colon = text.indexOf(':')
      if (colon > 0) {
        found.set(
          text.slice(0, colon).trim(),
          text
            .slice(colon + 1)
            .replace(/\s+/g, ' ')
            .trim(),
        )
      }
      text = ''
    } else text += char
  }
  return found
}

// A size in px from a product of px values, numbers, var(--prose-size) and var(--prose-scale), as
// calc() takes it.
function pixels(value: string, proseSize: string, proseScale = '1'): number {
  const product = /^calc\((.*)\)$/.exec(value)?.[1] ?? value
  return product.split('*').reduce((total, term) => {
    const vars: Record<string, string> = {
      'var(--prose-size)': proseSize,
      'var(--prose-scale)': proseScale,
    }
    const factor = vars[term.trim()] ?? term.trim()
    const number = Number(factor.replace(/px$/, ''))
    expect(Number.isFinite(number), `cannot read ${term} in ${value}`).toBe(true)
    return total * number
  }, 1)
}

describe('type in globals.css', () => {
  const textSizes = {
    small: declarationsAfter(":root[data-text-size='small']").get('--prose-size')!,
    default: declarationsAfter(':root {').get('--prose-size')!,
    large: declarationsAfter(":root[data-text-size='large']").get('--prose-size')!,
  }

  const scales = {
    builtIn: declarationsAfter(':root {').get('--prose-scale')!,
    serif: declarationsAfter(":root[data-font-prose='source-serif-4']").get('--prose-scale')!,
  }

  it.each([
    ['small', 13, 14.3],
    ['default', 14, 15.4],
    ['large', 15, 16.5],
  ] as const)(
    "sets the agent's prose at the prose size, or 1.1 times it in the serif, at the %s text size",
    (size, user, serif) => {
      const prose = textSizes[size]
      const font = declarationsAfter('.markdown {').get('font-size')!
      expect(pixels(prose, prose)).toBe(user)
      expect(pixels(font, prose, scales.builtIn)).toBeCloseTo(user)
      expect(pixels(font, prose, scales.serif)).toBeCloseTo(serif)
    },
  )

  it("sets thoughts, notes and summaries at 0.88 of the agent's prose", () => {
    const muted = declarationsAfter('.markdown-muted {').get('font-size')!
    expect(pixels(muted, textSizes.default, scales.serif)).toBeCloseTo(15.4 * 0.88)
  })

  it.each([
    ["[data-streamdown='inline-code']", '0.84em'],
    ['[data-file-ref]', '0.85em'],
  ])('sets %s in a reply at %s of the prose', (selector, size) => {
    expect(nestedDeclarationsAfter('.markdown {', selector).get('font-size')).toBe(size)
  })

  it('keeps a file chip at its own size in tool output', () => {
    expect(nestedDeclarationsAfter('.markdown-compact {', '[data-file-ref]').get('font-size')).toBe(
      '1em',
    )
  })

  // Chinese goes through the alias family, so the dark theme's lighter weights keep its faces.
  const alias = blocksAfter('@font-face')
    .map(declarations)
    .filter((face) => face.get('font-family') === "'Platform Chinese'")
  const faceFor = (weight: string) =>
    alias.filter((face) => {
      const [from, to] = face.get('font-weight')!.split(' ').map(Number)
      return from <= Number(weight) && Number(weight) <= to
    })
  const light = declarationsAfter(':root {')
  const dark = declarationsAfter("[data-theme='dark'] {")

  it.each([
    ['--weight-normal', ['PingFangSC-Regular', 'MicrosoftYaHei', 'NotoSansCJKsc-Regular']],
    ['--weight-medium', ['PingFangSC-Medium', 'MicrosoftYaHei', 'NotoSansCJKsc-Medium']],
    ['--weight-semibold', ['PingFangSC-Semibold', 'MicrosoftYaHei-Bold', 'NotoSansCJKsc-Bold']],
  ])('maps %s to the same Chinese faces in both themes', (token, faces) => {
    for (const weight of [light.get(token)!, dark.get(token)!]) {
      const matched = faceFor(weight)
      expect(matched, `one face for weight ${weight}`).toHaveLength(1)
      for (const face of faces) expect(matched[0].get('src')).toContain(`local('${face}')`)
    }
  })

  it('puts the alias family right after the Latin face of every face a theme may name', () => {
    for (const face of ['system', 'inter', 'source-serif-4', 'jetbrains-mono']) {
      expect(light.get(`--face-${face}`)!.split(',')[1].trim()).toBe("'Platform Chinese'")
    }
  })
})

describe('tables in globals.css', () => {
  it('keeps a table from scrolling inside itself', () => {
    const box = nestedDeclarationsAfter(
      '.markdown {',
      "[data-streamdown='table-wrapper'] > div:last-child",
    )
    expect(box.get('overflow')).toBe('visible')
    expect(box.get('overflow-x')).toBeUndefined()
    expect(box.get('overflow-y')).toBeUndefined()
  })

  it('wraps header cells between words and never between Han characters', () => {
    const header = nestedDeclarationsAfter('.markdown {', "[data-streamdown='table-header-cell']")
    expect(header.get('white-space')).toBe('normal')
    expect(header.get('word-break')).toBe('keep-all')
  })
})
