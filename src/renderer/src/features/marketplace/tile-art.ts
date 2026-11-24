// What a Marketplace item's tile shows, in order: a bundled brand mark; the icon of the site a
// remote MCP server connects to; a glyph and color Kettu gives the items it knows; a plugin's category glyph on its
// harness's color; else its kind's glyph and color.

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
  Flowchart01Icon,
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
import type { McpSpec, PluginHarness } from '@shared/marketplace'
import type { WireWorkflowEntry } from '@shared/workflow'
import { kettuId, type CommunityItem } from '@shared/market-community'
import { brandMark, type Mark } from './brand-marks'
import { pluginName } from './model'

/** What a tile stands for. `name` is a skill's or a server's name as its source gives it. */
export type TileSubject =
  | {
      kind: 'mcp'
      id: string
      brand: string | null
      /** The address a remote server connects to, whose site's icon stands for it. */
      site?: string | null
    }
  | {
      kind: 'plugin'
      harness: PluginHarness
      id: string
      category: string | null
      /** False for a plugin anyone may publish, whose name earns it no maker's mark. */
      marks?: boolean
    }
  | { kind: 'skill'; name: string }
  | { kind: 'workflow'; id: string; source: WireWorkflowEntry['source'] }
  | {
      // A Kettu plugin: the icon its package carries, else a glyph on a color its name picks.
      kind: 'kettu-plugin'
      name: string
      /** False for a plugin anyone may publish, whose name earns it no maker's mark. */
      marks: boolean
      /** The package's own icon, as a data URL. */
      icon: string | null
    }

export type TileSize = 'small' | 'row' | 'big'

export const serverSubject = (server: {
  id: string
  brand: string | null
  spec?: McpSpec
}): TileSubject => ({
  kind: 'mcp',
  id: server.id,
  brand: server.brand,
  site: server.spec?.type === 'http' ? server.spec.url : null,
})

export const pluginSubject = (plugin: {
  harness: PluginHarness
  id: string
  category?: string | null
  marks?: boolean
}): TileSubject => ({
  kind: 'plugin',
  harness: plugin.harness,
  id: plugin.id,
  category: plugin.category ?? null,
  ...(plugin.marks === false ? { marks: false } : {}),
})

export const skillSubject = (name: string): TileSubject => ({ kind: 'skill', name })

export const kettuPluginSubject = (plugin: {
  name: string
  official?: boolean
  icon?: string | null
}): TileSubject => ({
  kind: 'kettu-plugin',
  name: plugin.name,
  marks: plugin.official === true,
  icon: plugin.icon ?? null,
})

export const workflowSubject = (workflow: {
  id: string
  source: WireWorkflowEntry['source']
}): TileSubject => ({
  kind: 'workflow',
  id: workflow.id,
  source: workflow.source,
})

/** A listing's tile: its kind's glyph, never a maker's mark, since anyone may take a name. */
export function communitySubject(
  item: Pick<CommunityItem, 'id' | 'kind' | 'harness' | 'slug'> & { official?: boolean },
): TileSubject {
  const official = item.official === true
  if (item.kind === 'skill') return skillSubject(item.slug)
  if (item.kind === 'workflow') return workflowSubject({ id: item.slug, source: 'community' })
  if (item.kind === 'agent-plugin') return kettuPluginSubject({ name: item.slug, official })
  if (item.kind === 'plugin') {
    return pluginSubject({
      harness: item.harness ?? 'claude-code',
      id: item.slug,
      marks: false,
    })
  }
  return serverSubject({ id: kettuId(item.id), brand: null })
}

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

// The user's workflows, colored by how they came; an older host's own as the community's.
const WORKFLOW_COLOR: Record<WireWorkflowEntry['source'], string> = {
  official: 'var(--tile-teal)',
  github: 'var(--tile-sky)',
  file: 'var(--tile-slate)',
  agent: 'var(--tile-cyan)',
  user: 'var(--tile-violet)',
  community: 'var(--tile-teal)',
  plugin: 'var(--tile-teal)',
}

const HARNESS_COLOR: Record<PluginHarness, string> = {
  'claude-code': 'var(--brand-claude)',
  codex: 'var(--brand-codex-3)',
}

type Art = { type: 'mark'; mark: Mark } | { type: 'glyph'; icon: IconSvgElement; color: string }

function categoryGlyph(category: string | null): IconSvgElement {
  const words = category?.toLowerCase() ?? ''
  return CATEGORIES.find(([pattern]) => pattern.test(words))?.[1] ?? PuzzleIcon
}

// The colors a Kettu plugin's tile picks from by its name, the draft's mix of warm and cool.
const KETTU_PLUGIN_COLORS = [
  'var(--tile-violet)',
  'var(--tile-sky)',
  'var(--tile-teal)',
  'var(--tile-emerald)',
  'var(--tile-pink)',
  'var(--tile-cyan)',
  'var(--tile-amber)',
  'var(--tile-slate)',
]

function nameColor(name: string): string {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return KETTU_PLUGIN_COLORS[hash % KETTU_PLUGIN_COLORS.length]!
}

export function tileArt(subject: TileSubject): Art {
  if (subject.kind === 'kettu-plugin') {
    const mark = subject.marks ? brandMark(subject.name) : null
    if (mark) return { type: 'mark', mark }
    return { type: 'glyph', icon: PuzzleIcon, color: nameColor(subject.name) }
  }
  if (subject.kind === 'mcp') {
    const mark = brandMark(subject.brand)
    if (mark) return { type: 'mark', mark }
    const glyph = SERVERS[subject.id]
    return glyph
      ? { type: 'glyph', icon: glyph.icon, color: glyph.color ?? 'var(--tile-slate)' }
      : { type: 'glyph', icon: PlugSocketIcon, color: 'var(--tile-slate)' }
  }
  if (subject.kind === 'workflow') {
    return { type: 'glyph', icon: Flowchart01Icon, color: WORKFLOW_COLOR[subject.source] }
  }
  if (subject.kind === 'skill') {
    const glyph = SKILLS[subject.name]
    return glyph
      ? { type: 'glyph', icon: glyph.icon, color: glyph.color ?? 'var(--tile-violet)' }
      : { type: 'glyph', icon: SparklesIcon, color: 'var(--tile-violet)' }
  }
  const name = pluginName(subject.id)
  const marks = subject.marks !== false
  const mark = marks ? brandMark(name) : null
  if (mark) return { type: 'mark', mark }
  const glyph = marks ? PLUGINS[name] : undefined
  return {
    type: 'glyph',
    icon: glyph?.icon ?? categoryGlyph(subject.category),
    color: glyph?.color ?? HARNESS_COLOR[subject.harness],
  }
}
