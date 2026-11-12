import { createContext, useContext, useMemo, type ComponentProps, type ReactNode } from 'react'
import type { Components, ExtraProps, StreamdownProps } from 'streamdown'
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
    if (node.type === 'link' || node.type === 'linkReference') {
      if (node.url && node.children?.length === 1 && node.children[0]?.value === node.url) {
        node.url = PREFIX + encodeURIComponent(node.url)
      }
      return
    }
    if (!node.children) return
    node.children = node.children.flatMap((child) => {
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
