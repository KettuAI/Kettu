import { describe, expect, it } from 'vitest'
import { checkFile, locate } from './css-colors.mjs'
import { findColorLiterals } from './color-literals.mjs'

const matches = (text: string, options?: { css?: boolean; markup?: boolean }) =>
  findColorLiterals(text, options).map((found) => found.match)

describe('findColorLiterals: hex colors', () => {
  it('finds a hex color in a class string and in a style object', () => {
    expect(findColorLiterals('bg-[#fff] text-sm')).toEqual([
      { index: 4, match: '#fff', kind: 'hex' },
    ])
    expect(matches('fill-[#1a2b3c]')).toEqual(['#1a2b3c'])
    expect(matches('#ff000080')).toEqual(['#ff000080'])
    expect(matches('0 1px 2px #0003, 0 0 #abcd')).toEqual(['#0003', '#abcd'])
    expect(matches('1px solid #ccc')).toEqual(['#ccc'])
    expect(matches('linear-gradient(#fff,#000)')).toEqual(['#fff', '#000'])
    expect(matches('a:#fff')).toEqual(['#fff'])
  })

  it('takes a string that is only a color', () => {
    expect(matches('#d97757')).toEqual(['#d97757'])
  })

  it('leaves ids, anchors and other text alone', () => {
    expect(matches('#root')).toEqual([])
    expect(matches('#abcde')).toEqual([])
    expect(matches('#12345678a')).toEqual([])
    expect(matches('#')).toEqual([])
    expect(matches('#${color}')).toEqual([])
    expect(matches('src/a#fff')).toEqual([])
    expect(matches('url(#fff)')).toEqual([])
    expect(matches("url('#fade')")).toEqual([])
    expect(matches('url( #id )')).toEqual([])
    expect(matches('#fff-label')).toEqual([])
  })
})

describe('findColorLiterals: color functions', () => {
  it('finds the color functions', () => {
    for (const fn of ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch']) {
      expect(matches(`${fn}(0 0 0)`)).toEqual([`${fn}(`])
    }
    expect(matches('RGB(0 0 0)')).toEqual(['RGB('])
    expect(matches('color(display-p3 1 0 0)')).toEqual(['color('])
    expect(matches('color(from var(--x) srgb r g b)')).toEqual(['color('])
  })

  it('finds relative syntax and a function inside another', () => {
    expect(matches('oklch(from var(--x) l c h / 50%)')).toEqual(['oklch('])
    expect(matches('0 0 0 1px rgb(var(--c) / 0.1)')).toEqual(['rgb('])
  })

  it('finds a function in a Tailwind arbitrary value, where underscores are spaces', () => {
    expect(matches('bg-[oklch(0.5_0_0)]')).toEqual(['oklch('])
    expect(matches('shadow-[0_0_0_1px_rgb(0_0_0/0.1)]')).toEqual(['rgb('])
    expect(matches('shadow-[0_0_0_1px_oklch(from_var(--x)_l_c_h)]')).toEqual(['oklch('])
  })

  it('leaves color-mix, var and prose alone', () => {
    expect(matches('color-mix(in srgb, var(--a) 10%, transparent)')).toEqual([])
    expect(matches('color-mix(in oklch, var(--a), var(--b))')).toEqual([])
    expect(matches('var(--rgb)')).toEqual([])
    expect(matches('Pick a color(s) to show')).toEqual([])
    expect(matches('xrgb(1)')).toEqual([])
  })
})

describe('findColorLiterals: Tailwind palette utilities', () => {
  it('finds a palette step, black and white', () => {
    expect(matches('bg-red-500')).toEqual(['bg-red-500'])
    expect(matches('hover:text-white')).toEqual(['text-white'])
    expect(matches('p-2 bg-black rounded')).toEqual(['bg-black'])
    expect(matches('border-slate-950')).toEqual(['border-slate-950'])
    expect(matches('border-x-zinc-50 border-s-rose-100')).toEqual([
      'border-x-zinc-50',
      'border-s-rose-100',
    ])
    expect(matches('dark:ring-offset-amber-300')).toEqual(['ring-offset-amber-300'])
    expect(matches('from-sky-400 via-white to-emerald-600')).toEqual([
      'from-sky-400',
      'via-white',
      'to-emerald-600',
    ])
    expect(matches('inset-shadow-black drop-shadow-lime-200 decoration-pink-500')).toEqual([
      'inset-shadow-black',
      'drop-shadow-lime-200',
      'decoration-pink-500',
    ])
    expect(matches('!bg-red-500 group-hover:fill-blue-600 stroke-neutral-400')).toEqual([
      'bg-red-500',
      'fill-blue-600',
      'stroke-neutral-400',
    ])
  })

  it('takes the opacity with it', () => {
    expect(matches('bg-black/10')).toEqual(['bg-black/10'])
    expect(matches('shadow-black/10')).toEqual(['shadow-black/10'])
    expect(matches('text-red-500/[0.35] x')).toEqual(['text-red-500/[0.35]'])
    expect(matches('bg-white/(--alpha)')).toEqual(['bg-white/(--alpha)'])
  })

  it('leaves tokens and non-palette names alone', () => {
    expect(matches('bg-background')).toEqual([])
    expect(matches('text-muted-foreground')).toEqual([])
    expect(matches('bg-red')).toEqual([])
    expect(matches('bg-red-550')).toEqual([])
    expect(matches('bg-red-5000')).toEqual([])
    expect(matches('border-border text-primary/80 bg-surface')).toEqual([])
    expect(matches('text-sm text-white-label')).toEqual([])
    expect(matches('bg-transparent text-current border-none')).toEqual([])
    expect(matches('subtext-white')).toEqual([])
  })
})

describe('findColorLiterals: CSS', () => {
  it('finds named colors as the value of a color property, only in CSS', () => {
    expect(matches('color: red')).toEqual([])
    expect(findColorLiterals('a { color: red }', { css: true })).toEqual([
      { index: 11, match: 'red', kind: 'named' },
    ])
    expect(matches('a { background: white url(x.png) no-repeat }', { css: true })).toEqual([
      'white',
    ])
    expect(matches('a { border: 1px solid Tomato }', { css: true })).toEqual(['Tomato'])
    expect(matches('a { border-top-color: navy }', { css: true })).toEqual(['navy'])
    expect(matches('a { outline: 2px dashed gold; fill: teal }', { css: true })).toEqual([
      'gold',
      'teal',
    ])
    expect(matches('a { box-shadow: 0 0 0 1px red, 0 0 2px blue }', { css: true })).toEqual([
      'red',
      'blue',
    ])
    expect(
      matches('a { background: linear-gradient(to right, red, blue) }', { css: true }),
    ).toEqual(['red', 'blue'])
    expect(matches('a { text-decoration: underline wavy crimson }', { css: true })).toEqual([
      'crimson',
    ])
    expect(matches('a { --accent: red; }', { css: true })).toEqual(['red'])
  })

  it('leaves keywords, tokens, other properties and url() alone', () => {
    const css = (text: string) => matches(text, { css: true })
    expect(css('a { color: transparent }')).toEqual([])
    expect(css('a { color: currentColor; fill: none; stroke: inherit }')).toEqual([])
    expect(css('a { color: var(--red) }')).toEqual([])
    expect(css('a { color: var(--text-primary); background: var(--bg-app) }')).toEqual([])
    expect(css('a { border: 1px solid var(--border-default) }')).toEqual([])
    expect(css('a { font-family: tan; content: "red"; white-space: nowrap }')).toEqual([])
    expect(css('a { background: url(red.png) }')).toEqual([])
    expect(css('a { border-radius: 4px; border-top-left-radius: 2px }')).toEqual([])
    expect(css('a { --size: 4px; --tone: var(--red) }')).toEqual([])
    expect(css('a { transition: color 0.2s, background-color 0.2s }')).toEqual([])
  })

  it('does not read comments', () => {
    expect(matches('/* red */ a { color: transparent }', { css: true })).toEqual([])
    expect(matches('a { /* color: red; #fff rgb(0 0 0) */ }', { css: true })).toEqual([])
    expect(matches('/*\n a { color: red }\n*/ a { color: red }', { css: true })).toEqual(['red'])
  })

  it('keeps indexes stable around a comment', () => {
    const text = '/* a\nb */ a { color: red }'
    const [found] = findColorLiterals(text, { css: true })
    expect(text.slice(found.index, found.index + 3)).toBe('red')
  })

  it('finds hex colors and palette utilities in declarations and @apply', () => {
    expect(matches('a { color: #fff; background: #00000080 }', { css: true })).toEqual([
      '#fff',
      '#00000080',
    ])
    expect(matches('a { @apply bg-red-500 text-[#fff]; }', { css: true })).toEqual([
      'bg-red-500',
      '#fff',
    ])
    expect(matches('a { box-shadow: 0 0 rgb(0 0 0 / 5%) }', { css: true })).toEqual(['rgb('])
  })

  it('does not take an id selector for a hex color', () => {
    expect(matches('#add { color: var(--x) }', { css: true })).toEqual([])
    expect(matches('a { color: red }\n#fade, #bad { margin: 0 }', { css: true })).toEqual(['red'])
    expect(matches('a { fill: url(#fff) }', { css: true })).toEqual([])
  })
})

describe('findColorLiterals: markup', () => {
  it('finds quoted hex colors and color attributes', () => {
    const svg = '<svg><path fill="#fff" stroke="red" style="fill:#000;color: blue"/></svg>'
    expect(matches(svg, { markup: true })).toEqual(['#fff', 'red', '#000', 'blue'])
    expect(matches('<stop stop-color="#abc"/>', { markup: true })).toEqual(['#abc'])
  })

  it('leaves anchors, ids and none alone', () => {
    const svg =
      '<use href="#fade"/><use xlink:href="#bad"/><g id="add" fill="none" stroke="currentColor" filter="url(#fff)"/>'
    expect(matches(svg, { markup: true })).toEqual([])
    expect(matches('<div id="root"></div><!-- fill="red" -->', { markup: true })).toEqual([])
  })
})

describe('checkFile', () => {
  it('prints path:line:col with the message', () => {
    expect(checkFile('src/renderer/src/a.css', 'a {\n  color: red;\n}\n')).toEqual([
      "src/renderer/src/a.css:2:10 Color literal 'red': colors live in src/renderer/src/styles/tokens.css (see docs/design/design-system.md#color)",
    ])
  })

  it('skips the token file', () => {
    expect(checkFile('src/renderer/src/styles/tokens.css', ':root { --a: #fff; }')).toEqual([])
  })

  it('locates by line and column, 1-based', () => {
    expect(locate('ab\ncd', 0)).toEqual({ line: 1, column: 1 })
    expect(locate('ab\ncd', 4)).toEqual({ line: 2, column: 2 })
  })
})
