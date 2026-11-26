import { Fragment, useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { findChips, type Chip, type ChipContext } from '../composer/chips'
import { BlockCopy, BlockSpacer } from '../markdown/block-frame'
import { fenceFileName, fenceLanguage } from '../markdown/code-meta'
import { splitUserMessageSegments } from './sent-text-segments'

function VerbatimChips({
  text,
  atStart,
  context,
  renderChip,
}: {
  text: string
  atStart: boolean
  context: ChipContext
  renderChip: (chip: Chip, raw: string) => ReactNode
}) {
  const chips = useMemo(
    () => findChips(text, atStart ? context : { ...context, commands: [] }),
    [text, atStart, context],
  )
  if (chips.length === 0) {
    return <div className="whitespace-pre-wrap break-words">{text}</div>
  }
  const nodes: ReactNode[] = []
  let cursor = 0
  for (let i = 0; i < chips.length; i++) {
    const chip = chips[i]!
    if (chip.from > cursor) {
      nodes.push(<Fragment key={`t:${cursor}`}>{text.slice(cursor, chip.from)}</Fragment>)
    }
    const raw = text.slice(chip.from, chip.to)
    nodes.push(<Fragment key={`c:${chip.from}:${i}`}>{renderChip(chip, raw)}</Fragment>)
    cursor = chip.to
  }
  if (cursor < text.length) {
    nodes.push(<Fragment key={`t:${cursor}`}>{text.slice(cursor)}</Fragment>)
  }
  return <div className="whitespace-pre-wrap break-words">{nodes}</div>
}

function UserCodeBlock({ language, meta, code }: { language: string; meta: string; code: string }) {
  const { t } = useTranslation('session')
  const lang = fenceLanguage(language)
  const file = fenceFileName(language, meta || undefined)
  return (
    <div className="ks-user-code" data-user-code="">
      <div className="ks-user-code__header select-none">
        {file && (
          <span className="block-frame-name" title={file}>
            {file}
          </span>
        )}
        {lang && <span className="block-frame-lang">{lang}</span>}
        <BlockSpacer />
        <BlockCopy text={code} label={t('block.copy')} />
      </div>
      <pre className="ks-user-code__pre">
        <code>{code}</code>
      </pre>
    </div>
  )
}

/**
 * Renders a sent user message synchronously without running the Markdown pipeline: plain text is
 * preserved verbatim with Kettu chips (`/command`, `/skill`, `@mentions`, and links), and only
 * explicit fenced code blocks become monospace code cards.
 */
export function SentText({
  text,
  context,
  renderChip,
}: {
  text: string
  context: ChipContext
  renderChip: (chip: Chip, raw: string) => ReactNode
}) {
  const segments = useMemo(() => splitUserMessageSegments(text), [text])
  if (segments.length === 0) return null
  if (segments.length === 1 && segments[0]!.kind === 'text') {
    return (
      <div className="ks-user-text">
        <VerbatimChips
          text={segments[0]!.text}
          atStart={segments[0]!.offset === 0}
          context={context}
          renderChip={renderChip}
        />
      </div>
    )
  }
  return (
    <div className="ks-user-text flex flex-col gap-2">
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          <VerbatimChips
            key={`s:${index}:${segment.offset}`}
            text={segment.text}
            atStart={segment.offset === 0}
            context={context}
            renderChip={renderChip}
          />
        ) : (
          <UserCodeBlock
            key={`c:${index}:${segment.offset}`}
            language={segment.language}
            meta={segment.meta}
            code={segment.code}
          />
        ),
      )}
    </div>
  )
}
