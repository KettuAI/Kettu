import { createContext, useContext, useMemo, type ComponentProps, type ReactNode } from 'react'
import type { Components, ExtraProps, StreamdownProps } from 'streamdown'
import { schemelessGitHubUrl } from '@shared/git'
import { findChips, splitLines, type Chip, type ChipContext } from '../composer/chips'
import { Markdown } from '../markdown'
import { Link } from '../markdown/markdown-impl'

const PREFIX = '#prompt-chip:'
const SentChipsContext = createContext<{
  context: ChipContext
  render: (chip: Chip, raw: string) => ReactNode
} | null>(null)

interface MdNode {
  type: string
  value?: string
  url?: string
  position?: { start: { offset?: number } }
  children?: MdNode[]
}

interface ChipLinkOptions {
  chips: { chip: Chip; raw: string }[]
}

/**
 * A link whose text is its address, as markdown reads a typed address, or a GitHub link typed
 * without `https://`, which the reply's plugins link; its text, else null.
 */
function bareLinkText(node: MdNode): string | null {
  const only = node.children?.[0]
  if (node.type !== 'link' || node.children?.length !== 1 || only?.type !== 'text') return null
  if (typeof only.value !== 'string') return null
  return only.value === node.url || schemelessGitHubUrl(only.value) === node.url ? only.value : null
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

function chipLinks({ chips: known }: ChipLinkOptions) {
  const context: ChipContext = {
    commands: known.flatMap(({ chip }) => (chip.kind === 'command' ? [chip.name] : [])),
    resolve: (token) => {
      const found = known.find(
        ({ chip, raw }) =>
          chip.kind !== 'command' &&
          chip.kind !== 'link' &&
          splitLines(raw.slice(1)).name === token,
      )?.chip
      return found && found.kind !== 'command' && found.kind !== 'link' ? found : null
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
          url: PREFIX + encodeURIComponent(raw),
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

function ChipLink(props: ComponentProps<'a'> & ExtraProps) {
  const chips = useContext(SentChipsContext)
  if (chips && props.href?.startsWith(PREFIX)) {
    const raw = new URLSearchParams(`text=${props.href.slice(PREFIX.length)}`).get('text') ?? ''
    const chip = findChips(raw, chips.context)[0]
    if (chip) return chips.render(chip, raw)
  }
  return <Link {...props} />
}

const components: Components = { a: ChipLink }

export default function SentMarkdown({
  text,
  context,
  renderChip,
}: {
  text: string
  context: ChipContext
  renderChip: (chip: Chip, raw: string) => ReactNode
}) {
  const remarkPlugins = useMemo<StreamdownProps['remarkPlugins']>(
    () => [
      [
        chipLinks,
        {
          chips: findChips(text, context).map((chip) => ({
            chip,
            raw: text.slice(chip.from, chip.to),
          })),
        } satisfies ChipLinkOptions,
      ],
    ],
    [text, context],
  )
  return (
    <SentChipsContext value={{ context, render: renderChip }}>
      <Markdown
        markdown={text}
        className="markdown-user"
        components={components}
        remarkPlugins={remarkPlugins}
      />
    </SentChipsContext>
  )
}
