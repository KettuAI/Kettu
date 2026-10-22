import { FileIcon, LinkIcon } from 'lucide-react'
import type { ContentRef, UserContent } from '@shared/thread'
import { basename } from '@renderer/lib/format'
import { Clamp } from '../clamp'

/** Taller than this, a message collapses behind a fade and Show more. */
const COLLAPSED_HEIGHT = 300

/** The text, images and references of a prompt, as the user wrote them. */
export function UserContentView({ content }: { content: UserContent[] }) {
  const text = content
    .filter((c): c is Extract<UserContent, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n\n')
  const refs = content.flatMap((c) => (c.type === 'ref' ? [c.ref] : []))
  return (
    <div className="flex flex-col gap-2">
      {text && (
        <div className="flex flex-col gap-1">
          <Clamp maxHeight={COLLAPSED_HEIGHT} buttonClassName="-mx-1.5 -mb-0.5">
            <div className="whitespace-pre-wrap" data-selectable="">
              {text}
            </div>
          </Clamp>
        </div>
      )}
      {refs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {refs.map((ref, i) =>
            ref.kind === 'image' ? (
              <img
                key={i}
                alt=""
                src={`data:${ref.mimeType};base64,${ref.data}`}
                className="max-h-40 max-w-60 rounded-lg object-cover shadow-card"
              />
            ) : (
              <RefChip key={i} contentRef={ref} />
            ),
          )}
        </div>
      )}
    </div>
  )
}

/** A link or content OverBench cannot show, as a labelled chip. */
export function RefChip({ contentRef }: { contentRef: Exclude<ContentRef, { kind: 'image' }> }) {
  const link = contentRef.kind === 'link'
  return (
    <span
      className="inline-flex h-6 max-w-60 items-center gap-1.5 rounded-[6px] bg-background/60 px-2 text-xs text-muted-foreground shadow-card"
      title={link ? contentRef.uri : contentRef.label}
    >
      {link &&
        (contentRef.uri.startsWith('file:') ? (
          <FileIcon className="size-3 shrink-0" />
        ) : (
          <LinkIcon className="size-3 shrink-0" />
        ))}
      <span className="truncate">
        {link ? contentRef.name || basename(contentRef.uri) : contentRef.label}
      </span>
    </span>
  )
}
