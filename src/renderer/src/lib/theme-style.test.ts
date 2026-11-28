import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { contrastRatio, MIN_CONTRAST, parseColor, type Rgba, type ThemeMode } from '@shared/themes'

interface OfficialPalette {
  'bg-app': string
  'text-primary': string
  'text-secondary': string
  'text-tertiary': string
}

// Palettes from the seven official themes in KettuAI/themes (light and dark variants).
const OFFICIAL_THEMES: Record<string, Record<ThemeMode, OfficialPalette>> = {
  catppuccin: {
    light: {
      'bg-app': '#eff1f5',
      'text-primary': '#4c4f69',
      'text-secondary': '#55576f',
      'text-tertiary': '#5e6177',
    },
    dark: {
      'bg-app': '#1e1e2e',
      'text-primary': '#cdd6f4',
      'text-secondary': '#bac2de',
      'text-tertiary': '#a6adc8',
    },
  },
  gruvbox: {
    light: {
      'bg-app': '#fbf1c7',
      'text-primary': '#3c3836',
      'text-secondary': '#504945',
      'text-tertiary': '#665c54',
    },
    dark: {
      'bg-app': '#282828',
      'text-primary': '#ebdbb2',
      'text-secondary': '#d5c4a1',
      'text-tertiary': '#bdae93',
    },
  },
  nord: {
    light: {
      'bg-app': '#eceff4',
      'text-primary': '#2e3440',
      'text-secondary': '#3b4252',
      'text-tertiary': '#4c566a',
    },
    dark: {
      'bg-app': '#2e3440',
      'text-primary': '#eceff4',
      'text-secondary': '#d8dee9',
      'text-tertiary': '#aaafba',
    },
  },
  paper: {
    light: {
      'bg-app': '#fdfcf9',
      'text-primary': '#1c1b18',
      'text-secondary': '#55534c',
      'text-tertiary': '#68655d',
    },
    dark: {
      'bg-app': '#1c1b18',
      'text-primary': '#eceae3',
      'text-secondary': '#bab7ad',
      'text-tertiary': '#9a978f',
    },
  },
  'rose-pine': {
    light: {
      'bg-app': '#faf4ed',
      'text-primary': '#464261',
      'text-secondary': '#605c79',
      'text-tertiary': '#6a6683',
    },
    dark: {
      'bg-app': '#191724',
      'text-primary': '#e0def4',
      'text-secondary': '#9692b0',
      'text-tertiary': '#908caa',
    },
  },
  solarized: {
    light: {
      'bg-app': '#fdf6e3',
      'text-primary': '#4c6168',
      'text-secondary': '#657b83',
      'text-tertiary': '#657b83',
    },
    dark: {
      'bg-app': '#002b36',
      'text-primary': '#98a6a6',
      'text-secondary': '#839496',
      'text-tertiary': '#839496',
    },
  },
  'tokyo-night': {
    light: {
      'bg-app': '#e6e7ed',
      'text-primary': '#343b58',
      'text-secondary': '#474e6e',
      'text-tertiary': '#505673',
    },
    dark: {
      'bg-app': '#1a1b26',
      'text-primary': '#c0caf5',
      'text-secondary': '#a9b1d6',
      'text-tertiary': '#9aa5ce',
    },
  },
}

interface CssRule {
  selector: string
  atRule: string | null
  declarations: Map<string, string>
}

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()

function parseRules(css: string, atRule: string | null = null): CssRule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: CssRule[] = []
  let position = 0
  for (;;) {
    const open = stripped.indexOf('{', position)
    if (open === -1) return rules
    let depth = 1
    let close = open + 1
    for (; close < stripped.length && depth > 0; close++) {
      if (stripped[close] === '{') depth++
      else if (stripped[close] === '}') depth--
    }
    const prelude = normalize(stripped.slice(position, open).replace(/"/g, "'"))
    const body = stripped.slice(open + 1, close - 1)
    if (prelude.startsWith('@')) {
      rules.push(...parseRules(body, prelude))
    } else {
      const declarations = new Map<string, string>()
      for (const match of body.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)) {
        declarations.set(match[1]!, normalize(match[2]!))
      }
      rules.push({ selector: prelude, atRule, declarations })
    }
    position = close
  }
}

function findRule(rules: CssRule[], selector: string, atRule: string | null = null): CssRule {
  const rule = rules.find((entry) => entry.atRule === atRule && entry.selector === selector)
  if (!rule) throw new Error(`Missing CSS rule: ${atRule ?? ''} ${selector}`.trim())
  return rule
}

function resolveColor(expr: string, tokens: Map<string, string>, depth = 0): Rgba {
  if (depth > 16) throw new Error(`Circular token reference: ${expr}`)
  const trimmed = normalize(expr)
  const varRef = /^var\((--[\w-]+)\)$/.exec(trimmed)
  if (varRef) {
    const next = tokens.get(varRef[1]!)
    if (!next) throw new Error(`Unresolved CSS custom property: ${varRef[1]}`)
    return resolveColor(next, tokens, depth + 1)
  }
  const mix = /^color-mix\(\s*in srgb\s*,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(.+?)\s*\)$/.exec(
    trimmed,
  )
  if (mix) {
    const first = resolveColor(mix[1]!, tokens, depth + 1)
    const weight = Number(mix[2]!) / 100
    const second = resolveColor(mix[3]!, tokens, depth + 1)
    const blend = (a: number, b: number) => a * weight + b * (1 - weight)
    return {
      r: blend(first.r, second.r),
      g: blend(first.g, second.g),
      b: blend(first.b, second.b),
      a: blend(first.a, second.a),
    }
  }
  const parsed = parseColor(trimmed)
  if (!parsed) throw new Error(`Unsupported color value: ${trimmed}`)
  return parsed
}

function readStyle(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../styles/${name}`, import.meta.url)), 'utf8')
}

describe('prose vs tool-summary contrast hierarchy across built-in and official themes', () => {
  const tokenRules = parseRules(readStyle('tokens.css'))
  const affectRules = parseRules(readStyle('affect.css'))
  const sessionRules = parseRules(readStyle('session.css'))

  const lightBase = findRule(tokenRules, ":root, [data-theme='light']").declarations
  const darkBase = findRule(tokenRules, "[data-theme='dark']").declarations
  const installedBlock = findRule(
    tokenRules,
    ':root[data-installed-theme], [data-installed-theme] [data-theme]',
  ).declarations
  const sharedRoles = findRule(tokenRules, ':root, [data-theme]').declarations
  const installedTcc = findRule(
    affectRules,
    '[data-installed-theme] .ui-tcc, [data-installed-theme] .ui-tcc-group',
  ).declarations
  const answerMarkdownColor = findRule(sessionRules, '.ks-answer .markdown').declarations.get(
    'color',
  )
  const toolGroupHeadColor = findRule(
    sessionRules,
    '.ks-thread .ui-tcc-group__head',
  ).declarations.get('color')

  it('keeps built-in theme prose contrast well above tool-summary rows in light and dark modes', () => {
    expect(answerMarkdownColor).toBeDefined()
    expect(toolGroupHeadColor).toBeDefined()

    for (const mode of ['light', 'dark'] as const) {
      const tokens = new Map<string, string>([
        ...lightBase,
        ...(mode === 'dark' ? darkBase : []),
        ...sharedRoles,
      ])
      const bg = resolveColor('var(--bg-app)', tokens)
      const prose = resolveColor('var(--prose-text)', tokens)
      const answerProse = resolveColor(answerMarkdownColor!, tokens)
      const toolHead = resolveColor(toolGroupHeadColor!, tokens)

      const proseContrast = contrastRatio(prose, bg)
      const answerContrast = contrastRatio(answerProse, bg)
      const toolHeadContrast = contrastRatio(toolHead, bg)

      expect(proseContrast).toBeGreaterThanOrEqual(MIN_CONTRAST)
      expect(answerContrast).toBeGreaterThanOrEqual(MIN_CONTRAST)
      expect(toolHeadContrast).toBeGreaterThanOrEqual(MIN_CONTRAST)
      expect(proseContrast - toolHeadContrast).toBeGreaterThanOrEqual(4)
      expect(answerContrast - toolHeadContrast).toBeGreaterThanOrEqual(4)
    }
  })

  it('prevents prose vs tool-summary contrast inversion across every official theme in light and dark modes', () => {
    expect(answerMarkdownColor).toBeDefined()
    expect(toolGroupHeadColor).toBeDefined()
    expect(installedBlock.has('--prose-text')).toBe(false)
    expect(installedBlock.get('--thread-prose')).toBe('var(--text-primary)')

    for (const [themeName, variants] of Object.entries(OFFICIAL_THEMES)) {
      for (const mode of ['light', 'dark'] as const) {
        const palette = variants[mode]
        // Cascade order matches the browser: base tokens -> shared roles -> higher-specificity
        // installed-theme overrides -> theme palette -> affectUI component tokens.
        const tokens = new Map<string, string>([
          ...lightBase,
          ...(mode === 'dark' ? darkBase : []),
          ...sharedRoles,
          ...installedBlock,
          ['--bg-app', palette['bg-app']],
          ['--text-primary', palette['text-primary']],
          ['--text-secondary', palette['text-secondary']],
          ['--text-tertiary', palette['text-tertiary']],
          ...installedTcc,
        ])

        const bg = resolveColor('var(--bg-app)', tokens)
        const prose = resolveColor('var(--prose-text)', tokens)
        const answerProse = resolveColor(answerMarkdownColor!, tokens)
        const tccText = resolveColor('var(--ui-tcc-text)', tokens)
        const toolHead = resolveColor(toolGroupHeadColor!, tokens)

        const proseContrast = contrastRatio(prose, bg)
        const answerContrast = contrastRatio(answerProse, bg)
        const tccTextContrast = contrastRatio(tccText, bg)
        const toolHeadContrast = contrastRatio(toolHead, bg)

        expect(proseContrast, `${themeName} ${mode}: --prose-text AA`).toBeGreaterThanOrEqual(
          MIN_CONTRAST,
        )
        expect(
          answerContrast,
          `${themeName} ${mode}: .ks-answer .markdown AA`,
        ).toBeGreaterThanOrEqual(MIN_CONTRAST)
        expect(proseContrast, `${themeName} ${mode}: --prose-text > --ui-tcc-text`).toBeGreaterThan(
          tccTextContrast,
        )
        expect(
          answerContrast,
          `${themeName} ${mode}: .ks-answer .markdown > --ui-tcc-text`,
        ).toBeGreaterThan(tccTextContrast)
        expect(
          proseContrast - toolHeadContrast,
          `${themeName} ${mode}: --prose-text clearly exceeds tool summary head`,
        ).toBeGreaterThanOrEqual(1)
        expect(
          answerContrast - toolHeadContrast,
          `${themeName} ${mode}: .ks-answer .markdown clearly exceeds tool summary head`,
        ).toBeGreaterThanOrEqual(1)
      }
    }
  })
})

describe('serif Chinese font fallbacks in globals.css', () => {
  const globalsCss = readStyle('globals.css')
  const faceTokens = [...globalsCss.matchAll(/(--(?:face-[\w-]+|greeting-face))\s*:\s*([^;]+);/g)]
    .map((match) => [match[1]!, normalize(match[2]!)] as const)
    .reduce((map, [name, value]) => map.set(name, value), new Map<string, string>())

  const splitStack = (stack: string) =>
    stack.split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))

  it('uses Chinese serif fallbacks before generic serif families in --face-source-serif-4', () => {
    const sourceSerif = faceTokens.get('--face-source-serif-4')
    const greetingFace = faceTokens.get('--greeting-face')

    expect(sourceSerif).toBeDefined()
    expect(greetingFace).toBeDefined()
    expect(sourceSerif).toBe(greetingFace)

    const families = splitStack(sourceSerif!)
    expect(families[0]).toBe('Source Serif 4 Variable')

    const genericIndex = families.indexOf('ui-serif')
    expect(genericIndex).toBeGreaterThan(0)
    for (const cjkSerif of ['Songti SC', 'STSong', 'SimSun', 'Noto Serif CJK SC']) {
      const idx = families.indexOf(cjkSerif)
      expect(idx, `expected ${cjkSerif} in --face-source-serif-4`).toBeGreaterThan(0)
      expect(idx, `expected ${cjkSerif} before ui-serif`).toBeLessThan(genericIndex)
    }

    for (const cjkSans of [
      'Platform Chinese',
      'PingFang SC',
      'Microsoft YaHei',
      'Noto Sans CJK SC',
    ]) {
      expect(families).not.toContain(cjkSans)
    }
  })

  it('keeps every serif --face-* stack free of sans-serif Chinese fallbacks', () => {
    const serifFaces = [...faceTokens.entries()].filter(
      ([name, value]) => name.startsWith('--face-') && splitStack(value).at(-1) === 'serif',
    )
    expect(serifFaces.length).toBeGreaterThan(0)

    for (const [name, value] of serifFaces) {
      const families = splitStack(value)
      expect(families, `${name} should include Songti SC`).toContain('Songti SC')
      expect(families, `${name} should include Noto Serif CJK SC`).toContain('Noto Serif CJK SC')
      expect(families, `${name} should not fall back to Platform Chinese`).not.toContain(
        'Platform Chinese',
      )
    }
  })
})
