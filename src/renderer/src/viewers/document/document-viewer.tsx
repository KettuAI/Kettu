import { memo, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { cjk } from '@streamdown/cjk'
import { createCodePlugin } from '@streamdown/code'
import { useTranslation } from 'react-i18next'
import { defaultRehypePlugins, Streamdown, type ExtraProps, type StreamdownProps } from 'streamdown'
import { markdownBlocks } from '@shared/artifact-document'
import type { ViewerConfig, ViewerView } from '@shared/artifact-types'
import { Empty, EmptyDescription, EmptyHeader } from '@renderer/components/ui/empty'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { kettuCodeTheme } from '@renderer/features/session/markdown/code-themes'
import { cn } from '@renderer/lib/utils'
import { markReady } from '../common/boot'
import { EditBar, EditButton, SaveNotice } from '../common/content'
import { useContent } from '../common/use-content'

const plugins = {
  code: createCodePlugin({ themes: [kettuCodeTheme('light'), kettuCodeTheme('dark')] }),
  cjk,
}

// Links leave the page through the app, which asks before it opens one.
const linkSafety = { enabled: false }

/** A link, opened in the whole frame, where Kettu catches it and offers the browser. */
function Link({ href, title, children }: ComponentProps<'a'> & ExtraProps) {
  return (
    <a data-streamdown="link" href={href} title={title} target="_self" rel="noreferrer">
      {children}
    </a>
  )
}

const components = { a: Link }

// Pictures are the version's files, by paths relative to the page, which Streamdown lets through
// only when it has a base to resolve them against.
const rehypePlugins: StreamdownProps['rehypePlugins'] = Object.entries(defaultRehypePlugins).map(
  ([name, plugin]) =>
    name === 'harden' && Array.isArray(plugin)
      ? [plugin[0], { ...(plugin[1] as object), defaultOrigin: location.href }]
      : plugin,
)

/**
 * One block of the Markdown. Each renders apart, with the document's link definitions, so a block
 * that changes renders alone.
 */
const Block = memo(function Block({ source }: { source: string }) {
  return (
    <Streamdown
      mode="static"
      skipHtml
      plugins={plugins}
      components={components}
      rehypePlugins={rehypePlugins}
      linkSafety={linkSafety}
      controls={false}
      lineNumbers={false}
    >
      {source}
    </Streamdown>
  )
})

interface Part {
  from: number
  to: number
  source: string
}

/** The text's blocks with the link definitions each needs to render on its own. */
function partsOf(text: string): Part[] {
  const blocks = markdownBlocks(text)
  const definitions = blocks
    .filter((block) => block.kind === 'LinkReference')
    .map((block) => text.slice(block.from, block.to))
    .join('\n')
  return blocks
    .filter((block) => block.kind !== 'LinkReference')
    .map((block) => ({
      from: block.from,
      to: block.to,
      source: definitions
        ? `${text.slice(block.from, block.to)}\n\n${definitions}`
        : text.slice(block.from, block.to),
    }))
}

/** A block's source, in a box that grows with it, where it stood. */
function BlockEditor({
  value,
  onChange,
  onDone,
}: {
  value: string
  onChange: (value: string) => void
  onDone: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const area = ref.current
    if (!area) return
    area.style.height = 'auto'
    area.style.height = `${area.scrollHeight}px`
  }, [value])
  useLayoutEffect(() => ref.current?.focus(), [])
  return (
    <textarea
      ref={ref}
      value={value}
      spellCheck
      onChange={(event) => onChange(event.target.value)}
      onBlur={onDone}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onDone()
      }}
      className="my-2 block w-full resize-none overflow-hidden rounded-lg bg-card px-3 py-2 font-mono text-code text-foreground shadow-field outline-none focus:shadow-field-focus"
    />
  )
}

export function DocumentViewer({ config, view }: { config: ViewerConfig; view: ViewerView }) {
  const { t } = useTranslation('viewers')
  const content = useContent(config)
  const [draft, setDraft] = useState<string | null>(null)
  const [active, setActive] = useState<{ from: number; to: number; text: string } | null>(null)
  const text = draft ?? content.text ?? ''
  const editing = draft !== null
  const interactive = view === 'normal'

  // The block being edited stays one box, however its text splits, until it is left.
  const shown = active ? text.slice(0, active.from) + active.text + text.slice(active.to) : text
  const before = useMemo(() => partsOf(active ? text.slice(0, active.from) : text), [text, active])
  const after = useMemo(() => (active ? partsOf(text.slice(active.to)) : []), [text, active])

  useLayoutEffect(() => {
    if (content.text !== null) void markReady()
  }, [content.text])

  if (content.failed) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyDescription>{t('load.failed')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const commit = () => {
    if (!active) return
    setDraft(shown)
    setActive(null)
  }

  const renderPart = (part: Part, offset: number) =>
    editing && !active ? (
      <div
        key={`${offset + part.from}`}
        role="button"
        tabIndex={0}
        aria-label={t('document.blockLabel')}
        onClick={() =>
          setActive({
            from: offset + part.from,
            to: offset + part.to,
            text: text.slice(offset + part.from, offset + part.to),
          })
        }
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          setActive({
            from: offset + part.from,
            to: offset + part.to,
            text: text.slice(offset + part.from, offset + part.to),
          })
        }}
        className="-mx-3 cursor-text rounded-lg px-3 transition-shadow duration-(--duration-fast) hover:shadow-outline-hover"
      >
        <Block source={part.source} />
      </div>
    ) : (
      <Block key={`${offset + part.from}`} source={part.source} />
    )

  return (
    <main className={cn('min-h-full bg-background', view === 'thumbnail' && 'document-thumbnail')}>
      {interactive && content.head !== null && !editing && (
        <EditButton onClick={() => setDraft(content.text ?? '')} />
      )}
      <article
        className={cn('markdown mx-auto max-w-2xl px-8 py-14', editing && 'pb-28')}
        aria-busy={content.text === null}
      >
        {content.text === null ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : (
          <>
            {before.map((part) => renderPart(part, 0))}
            {active && (
              <BlockEditor
                value={active.text}
                onChange={(value) => setActive({ ...active, text: value })}
                onDone={commit}
              />
            )}
            {active && after.map((part) => renderPart(part, active.to))}
          </>
        )}
      </article>
      {editing && content.head !== null && (
        <EditBar
          hint={t('document.editHint')}
          dirty={shown !== content.text}
          head={content.head}
          status={content.status}
          onDiscard={() => {
            setActive(null)
            setDraft(null)
          }}
          onSave={() => {
            const next = shown
            setActive(null)
            void content.save(next).then((saved) => saved && setDraft(null))
          }}
        />
      )}
      {interactive && <SaveNotice status={content.status} onDismiss={content.dismiss} />}
    </main>
  )
}
