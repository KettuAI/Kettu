import type { ReactNode } from 'react'
import type { PluginLinkCard } from '@shared/plugin-refs'
import { Glyph } from '@renderer/features/shell/glyph'
import { Pill, Stat, Title } from '@renderer/features/git/gh-reference'
import { PluginMark } from '@renderer/features/plugin-views/plugin-mark'
import { VIEW_ICONS } from '@renderer/features/plugin-views/icons'
import { cn } from '@renderer/lib/utils'
import type { PluginLink } from './use-plugin-link'

// The title after a bare address, cut so a reference never takes over its line.
const TITLE_CHARS = 48

const TONE_TEXT = {
  success: 'text-success',
  danger: 'text-danger',
  warning: 'text-warning',
  info: 'text-info',
  neutral: 'text-icon',
} as const

const TONE_PILL = {
  success: 'open',
  danger: 'closed',
  warning: 'warning',
  info: 'info',
  neutral: 'gray',
} as const

function clip(title: string): string {
  const chars = [...title]
  return chars.length > TITLE_CHARS ? chars.slice(0, TITLE_CHARS - 1).join('') + '…' : title
}

function toneOf(card: PluginLinkCard): keyof typeof TONE_TEXT {
  return card.badges?.[0]?.tone ?? 'neutral'
}

/**
 * A plugin reference's text inside its link: its icon in the tone of the first badge, then the
 * agent's own words, or for a bare address the label and the title.
 */
export function PluginReferenceText({
  link,
  bare,
  children,
}: {
  link: PluginLink
  bare: boolean
  children: ReactNode
}) {
  const { card, found } = link
  const icon = card.icon ?? found.link.icon ?? 'link'
  return (
    <>
      <span className="whitespace-nowrap">
        <Glyph
          icon={VIEW_ICONS[icon]}
          size={14}
          className={cn(
            'relative -top-[1.5px] mr-1 inline-block align-middle',
            TONE_TEXT[toneOf(card)],
          )}
        />
        {bare && card.label ? <span className="font-medium">{card.label}</span> : null}
      </span>
      {bare ? (
        <span className={card.label ? 'text-tertiary' : 'font-medium'}>
          {card.label ? ' · ' : ''}
          {clip(card.title)}
        </span>
      ) : (
        children
      )}
    </>
  )
}

/** A plugin reference's card: what it is, its state, what the plugin says of it. */
export function PluginReferenceCard({ link, url }: { link: PluginLink; url: string }) {
  const { card, found } = link
  const [badge, ...others] = card.badges ?? []
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <PluginMark source={found.source} />
        <span className="min-w-0 truncate font-mono text-meta text-tertiary">
          {card.label ?? found.source.title}
        </span>
        {badge && (
          <span className="ml-auto shrink-0">
            <Pill tone={TONE_PILL[badge.tone ?? 'neutral']}>{badge.text}</Pill>
          </span>
        )}
      </div>
      <Title url={url} title={card.title} />
      {card.subtitle && <div className="-mt-1.5 text-xs text-tertiary">{card.subtitle}</div>}
      {card.body && (
        <p className="line-clamp-3 text-small leading-snug text-secondary">{card.body}</p>
      )}
      {others.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {others.map((other, i) => (
            <span
              key={i}
              className="inline-flex h-5 max-w-40 items-center rounded-full px-1.75 text-xs text-secondary shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]"
            >
              <span className="truncate">{other.text}</span>
            </span>
          ))}
        </div>
      )}
      {card.fields && card.fields.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {card.fields.map((field, i) => (
            <Stat key={i}>
              <span>{field.label}</span>
              <span className={cn('text-secondary', field.mono && 'font-mono text-meta')}>
                {field.value}
              </span>
            </Stat>
          ))}
        </div>
      )}
    </>
  )
}
