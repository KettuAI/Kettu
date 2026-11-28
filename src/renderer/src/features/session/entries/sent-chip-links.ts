// Remark plugin for SentMarkdown: unlinks auto-linked addresses and GitHub short references back
// to text so `findChips` turns them into Kettu chips consistently with the composer and SentText.

import { qualifiedGitHubRefUrl, schemelessGitHubUrl, type GitHubRepository } from '@shared/git'
import { findChips, splitLines, type Chip, type ChipContext } from '../composer/chips'
import { bareReferenceNumber } from '../markdown/github-refs'

export const SENT_CHIP_PREFIX = '#prompt-chip:'

interface MdNode {
  type: string
  value?: string
  url?: string
  position?: { start: { offset?: number } }
  children?: MdNode[]
}

export interface ChipLinkOptions {
  chips: { chip: Chip; raw: string }[]
  githubRepo?: GitHubRepository | null
}

/**
 * A link whose text is its address, as markdown reads a typed address, or a GitHub link / short
 * reference (`#123`, `owner/repo#123`) that the reply's plugins auto-linked; its text, else null.
 */
function bareLinkText(node: MdNode): string | null {
  const only = node.children?.[0]
  if (node.type !== 'link' || node.children?.length !== 1 || only?.type !== 'text') return null
  if (typeof only.value !== 'string' || typeof node.url !== 'string') return null
  if (only.value === node.url || schemelessGitHubUrl(only.value) === node.url) return only.value
  const bare = bareReferenceNumber(node.url)
  if (bare !== null && only.value === `#${bare}`) return only.value
  if (qualifiedGitHubRefUrl(only.value) === node.url) return only.value
  return null
}

// A typed address runs to the next space in markdown, over Chinese text and a second address too.
// It is turned back to text, so the chips are cut from it as the composer cut them.
function unlinkAddresses(children: MdNode[]): MdNode[] {
  const out: MdNode[] = []
  for (const child of children) {
    const value = child.type === 'text' ? (child.value ?? '') : bareLinkText(child)
    const last = out.at(-1)
    if (value === null) out.push(child)
    else if (last?.type === 'text')
      out[out.length - 1] = { ...last, value: `${last.value}${value}` }
    else out.push({ type: 'text', value, position: child.position })
  }
  return out
}

/** Remark plugin that converts composer chips inside Markdown prose into `#prompt-chip:` links. */
export function chipLinks({ chips: known, githubRepo }: ChipLinkOptions) {
  const context: ChipContext = {
    commands: known.flatMap(({ chip }) => (chip.kind === 'command' ? [chip.name] : [])),
    skills: known.flatMap(({ chip }) => (chip.kind === 'skill' ? [chip.name] : [])),
    githubRepo: githubRepo ?? null,
    resolve: (token) => {
      const found = known.find(
        ({ chip, raw }) =>
          chip.kind !== 'command' &&
          chip.kind !== 'skill' &&
          chip.kind !== 'link' &&
          splitLines(raw.slice(1)).name === token,
      )?.chip
      return found && found.kind !== 'command' && found.kind !== 'skill' && found.kind !== 'link'
        ? found
        : null
    },
  }
  const visit = (node: MdNode): void => {
    if (node.type === 'link' || node.type === 'linkReference') return
    if (!node.children) return
    node.children = unlinkAddresses(node.children).flatMap((child) => {
      if (child.type !== 'text' || !child.value) {
        visit(child)
        return [child]
      }
      const text = child.value
      const chips = findChips(text, {
        ...context,
        commands: child.position?.start.offset === 0 ? context.commands : [],
      })
      const parts: MdNode[] = []
      let at = 0
      for (const chip of chips) {
        if (chip.from > at) parts.push({ type: 'text', value: text.slice(at, chip.from) })
        const raw = text.slice(chip.from, chip.to)
        parts.push({
          type: 'link',
          url: SENT_CHIP_PREFIX + encodeURIComponent(raw),
          children: [{ type: 'text', value: raw }],
        })
        at = chip.to
      }
      if (at < text.length) parts.push({ type: 'text', value: text.slice(at) })
      return parts
    })
  }
  return visit
}
