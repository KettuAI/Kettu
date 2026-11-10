// What a Marketplace item's tile shows, in order: a bundled brand mark; a plugin's own logo, which
// the host reads from the package on its computer; a glyph and color Kettu gives the items it
// knows; a plugin's category glyph on its harness's color; else its kind's glyph and color.

import {
  AiBrain01Icon,
  Analytics01Icon,
  ArrowDataTransferHorizontalIcon,
  Book02Icon,
  BookOpen01Icon,
  BrowserIcon,
  Briefcase01Icon,
  Calculator01Icon,
  CheckListIcon,
  CodeIcon,
  ColorPickerIcon,
  CommandLineIcon,
  Database01Icon,
  Doc01Icon,
  FlashIcon,
  GitPullRequestIcon,
  Image01Icon,
  Location01Icon,
  Mail01Icon,
  Message01Icon,
  Money03Icon,
  Note01Icon,
  PaintBrush01Icon,
  Pdf01Icon,
  PenTool03Icon,
  PlugSocketIcon,
  Ppt01Icon,
  PuzzleIcon,
  Rocket01Icon,
  Shield01Icon,
  SparklesIcon,
  TestTube01Icon,
  Wrench01Icon,
  Xls01Icon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import type { PluginHarness } from '@shared/marketplace'
import { brandMark, type Mark } from './brand-marks'
import { pluginName } from './model'

/** What a tile stands for. `name` is a skill's or a server's name as its source gives it. */
export type TileSubject =
  | { kind: 'mcp'; id: string; brand: string | null }
  | { kind: 'plugin'; harness: PluginHarness; id: string; category: string | null }
  | { kind: 'skill'; name: string }

export type TileSize = 'small' | 'row' | 'big'

export const serverSubject = (server: { id: string; brand: string | null }): TileSubject => ({
  kind: 'mcp',
  id: server.id,
  brand: server.brand,
})

export const pluginSubject = (plugin: {
  harness: PluginHarness
  id: string
  category?: string | null
}): TileSubject => ({
  kind: 'plugin',
  harness: plugin.harness,
  id: plugin.id,
  category: plugin.category ?? null,
})

export const skillSubject = (name: string): TileSubject => ({ kind: 'skill', name })

interface Glyph {
  icon: IconSvgElement
  /** The tile's color; the harness's for a plugin when absent. */
  color?: string
}

// The skills of anthropics/skills, which the catalog lists first.
const SKILLS: Record<string, Glyph> = {
  pdf: { icon: Pdf01Icon, color: 'var(--tile-pdf)' },
  docx: { icon: Doc01Icon, color: 'var(--tile-word)' },
  xlsx: { icon: Xls01Icon, color: 'var(--tile-excel)' },
  pptx: { icon: Ppt01Icon, color: 'var(--tile-powerpoint)' },
  'webapp-testing': { icon: TestTube01Icon, color: 'var(--tile-teal)' },
  'mcp-builder': { icon: PlugSocketIcon, color: 'var(--tile-violet)' },
  'skill-creator': { icon: SparklesIcon, color: 'var(--tile-violet)' },
  'frontend-design': { icon: PaintBrush01Icon, color: 'var(--tile-cyan)' },
  'canvas-design': { icon: ColorPickerIcon, color: 'var(--tile-pink)' },
  'algorithmic-art': { icon: PenTool03Icon, color: 'var(--tile-pink)' },
  'theme-factory': { icon: PaintBrush01Icon, color: 'var(--tile-pink)' },
  'brand-guidelines': { icon: Book02Icon, color: 'var(--tile-amber)' },
  'slack-gif-creator': { icon: Image01Icon, color: 'var(--tile-amber)' },
  'internal-comms': { icon: Mail01Icon, color: 'var(--tile-sky)' },
  'web-artifacts-builder': { icon: BrowserIcon, color: 'var(--tile-sky)' },
  'doc-coauthoring': { icon: Note01Icon, color: 'var(--tile-slate)' },
}

// The best-known plugins without a brand, on their harness's color.
const PLUGINS: Record<string, Glyph> = {
  'code-review': { icon: GitPullRequestIcon },
  'pr-review-toolkit': { icon: GitPullRequestIcon },
  'frontend-design': { icon: PaintBrush01Icon },
  'commit-commands': { icon: CommandLineIcon },
  'security-guidance': { icon: Shield01Icon },
  'feature-dev': { icon: CodeIcon },
  'code-simplifier': { icon: Wrench01Icon },
  'agent-sdk-dev': { icon: AiBrain01Icon },
  'plugin-dev': { icon: PuzzleIcon },
  'skill-creator': { icon: SparklesIcon },
  superpowers: { icon: FlashIcon },
  context7: { icon: BookOpen01Icon },
}

const SERVERS: Record<string, Glyph> = {
  'io.github.upstash/context7': { icon: BookOpen01Icon, color: 'var(--tile-emerald)' },
  'com.neon/mcp': { icon: Database01Icon, color: 'var(--tile-emerald)' },
  'com.zapier/mcp': { icon: FlashIcon, color: 'var(--brand-zapier)' },
  'com.canva.mcp/mcp': { icon: PaintBrush01Icon, color: 'var(--brand-canva)' },
}

// Plugin categories as Claude Code's and Codex's marketplaces word them, by a word in them.
const CATEGORIES: [RegExp, IconSvgElement][] = [
  [/secur/, Shield01Icon],
  [/test/, TestTube01Icon],
  [/data|database/, Database01Icon],
  [/monitor|analytic|observ/, Analytics01Icon],
  [/deploy|infra/, Rocket01Icon],
  [/design|creativ/, PaintBrush01Icon],
  [/automat|workflow/, FlashIcon],
  [/learn|educat|research/, BookOpen01Icon],
  [/location|travel|map/, Location01Icon],
  [/math|financ/, Calculator01Icon],
  [/money|payment|commerce/, Money03Icon],
  [/migrat/, ArrowDataTransferHorizontalIcon],
  [/communicat|chat|messag/, Message01Icon],
  [/business|operation/, Briefcase01Icon],
  [/productiv/, CheckListIcon],
  [/develop|engineer|code/, CodeIcon],
]

const HARNESS_COLOR: Record<PluginHarness, string> = {
  'claude-code': 'var(--brand-claude)',
  codex: 'var(--brand-codex-3)',
}

type Art = { type: 'mark'; mark: Mark } | { type: 'glyph'; icon: IconSvgElement; color: string }

function categoryGlyph(category: string | null): IconSvgElement {
  const words = category?.toLowerCase() ?? ''
  return CATEGORIES.find(([pattern]) => pattern.test(words))?.[1] ?? PuzzleIcon
}

export function tileArt(subject: TileSubject): Art {
  if (subject.kind === 'mcp') {
    const mark = brandMark(subject.brand)
    if (mark) return { type: 'mark', mark }
    const glyph = SERVERS[subject.id]
    return glyph
      ? { type: 'glyph', icon: glyph.icon, color: glyph.color ?? 'var(--tile-slate)' }
      : { type: 'glyph', icon: PlugSocketIcon, color: 'var(--tile-slate)' }
  }
  if (subject.kind === 'skill') {
    const glyph = SKILLS[subject.name]
    return glyph
      ? { type: 'glyph', icon: glyph.icon, color: glyph.color ?? 'var(--tile-violet)' }
      : { type: 'glyph', icon: SparklesIcon, color: 'var(--tile-violet)' }
  }
  const name = pluginName(subject.id)
  const mark = brandMark(name)
  if (mark) return { type: 'mark', mark }
  const glyph = PLUGINS[name]
  return {
    type: 'glyph',
    icon: glyph?.icon ?? categoryGlyph(subject.category),
    color: glyph?.color ?? HARNESS_COLOR[subject.harness],
  }
}
