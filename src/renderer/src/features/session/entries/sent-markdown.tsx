import { createContext, useContext, useMemo, type ComponentProps, type ReactNode } from 'react'
import type { Components, ExtraProps, StreamdownProps } from 'streamdown'
import { findChips, type Chip, type ChipContext } from '../composer/chips'
import { Markdown } from '../markdown'
import { Link } from '../markdown/markdown-impl'
import { chipLinks, SENT_CHIP_PREFIX, type ChipLinkOptions } from './sent-chip-links'

const SentChipsContext = createContext<{
  context: ChipContext
  render: (chip: Chip, raw: string) => ReactNode
} | null>(null)

function ChipLink(props: ComponentProps<'a'> & ExtraProps) {
  const chips = useContext(SentChipsContext)
  if (chips && props.href?.startsWith(SENT_CHIP_PREFIX)) {
    const raw =
      new URLSearchParams(`text=${props.href.slice(SENT_CHIP_PREFIX.length)}`).get('text') ?? ''
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
          githubRepo: context.githubRepo ?? null,
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
