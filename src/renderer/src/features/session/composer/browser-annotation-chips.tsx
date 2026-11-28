import {
  Cancel01Icon,
  CursorRectangleSelection01Icon,
  Globe02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { BrowserElementAnnotation } from '@shared/browser'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import {
  browserAnnotationHost,
  browserAnnotationLabel,
  removeDraftBrowserAnnotation,
  useDraftBrowserAnnotations,
} from './browser-annotations'

/**
 * Removable chips for browser elements picked in annotation mode, rendered above the composer
 * editor so the user can review each reference on hover and remove unwanted ones before sending.
 */
export function BrowserAnnotationChips({ draft, onLeave }: { draft: string; onLeave: () => void }) {
  const { t } = useTranslation('composer')
  const items = useDraftBrowserAnnotations(draft)
  if (items.length === 0) return null

  return (
    <div
      role="list"
      aria-label={t('browserAnnotations.label')}
      data-composer-own=""
      data-browser-annotations=""
      className="flex w-full flex-wrap items-center gap-1.5 pb-1.5"
    >
      {items.map((item) => {
        const label = browserAnnotationLabel(item)
        const host = browserAnnotationHost(item.url)
        return (
          <div
            key={item.id}
            role="listitem"
            data-browser-annotation-chip=""
            className="flex h-6.5 max-w-72 min-w-0 animate-in items-center gap-1 rounded-lg bg-subtle pr-0.5 pl-2 text-small text-secondary shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] transition-shadow duration-(--duration-fast) fade-in animation-duration-(--duration-fast) hover:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]"
          >
            <HoverCard>
              <HoverCardTrigger
                delay={200}
                render={
                  <button
                    type="button"
                    aria-label={t('browserAnnotations.inspect', { label })}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none transition-colors duration-(--duration-fast) hover:text-primary focus-ring"
                  />
                }
              >
                <HugeiconsIcon
                  aria-hidden
                  icon={CursorRectangleSelection01Icon}
                  strokeWidth={1.9}
                  className="size-3.25 shrink-0 text-control-on"
                />
                <span className="min-w-0 truncate">{label}</span>
                <span className="shrink-0 text-caption text-tertiary">{host}</span>
              </HoverCardTrigger>
              <HoverCardContent side="top" align="start" sideOffset={6} className="w-80 p-3">
                <BrowserAnnotationPreview annotation={item} />
              </HoverCardContent>
            </HoverCard>
            <button
              type="button"
              aria-label={t('browserAnnotations.remove', { label })}
              onClick={() => {
                removeDraftBrowserAnnotation(draft, item.id)
                onLeave()
              }}
              className="flex size-5.5 shrink-0 items-center justify-center rounded-md text-tertiary outline-none transition-colors duration-(--duration-fast) hover:bg-hover hover:text-secondary focus-ring"
            >
              <HugeiconsIcon
                aria-hidden
                icon={Cancel01Icon}
                strokeWidth={1.9}
                className="size-3.5"
              />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** Compact read-only chips rendered inside a sent user message bubble for referenced browser elements. */
export function SentBrowserAnnotationChips({
  annotations,
}: {
  annotations: readonly BrowserElementAnnotation[]
}) {
  const { t } = useTranslation('composer')
  if (annotations.length === 0) return null

  return (
    <div
      role="list"
      aria-label={t('browserAnnotations.sentLabel')}
      className="flex flex-wrap items-center gap-1.5"
    >
      {annotations.map((item) => {
        const label = browserAnnotationLabel(item)
        const host = browserAnnotationHost(item.url)
        return (
          <HoverCard key={item.id}>
            <HoverCardTrigger
              delay={200}
              render={
                <button
                  type="button"
                  role="listitem"
                  aria-label={t('browserAnnotations.inspect', { label })}
                  className="inline-flex h-6 max-w-72 items-center gap-1.5 overflow-hidden rounded-md bg-background/60 px-2 text-xs text-secondary shadow-card outline-none transition-colors duration-(--duration-fast) hover:text-primary focus-ring"
                />
              }
            >
              <HugeiconsIcon
                aria-hidden
                icon={CursorRectangleSelection01Icon}
                strokeWidth={1.9}
                className="size-3 shrink-0 text-control-on"
              />
              <span className="min-w-0 truncate">{label}</span>
              <span className="shrink-0 text-caption text-tertiary">{host}</span>
            </HoverCardTrigger>
            <HoverCardContent side="top" align="start" sideOffset={6} className="w-80 p-3">
              <BrowserAnnotationPreview annotation={item} />
            </HoverCardContent>
          </HoverCard>
        )
      })}
    </div>
  )
}

/** Hover preview card showing full page URL, element locator details, and visible excerpt. */
function BrowserAnnotationPreview({ annotation }: { annotation: BrowserElementAnnotation }) {
  const { t } = useTranslation('composer')
  const attrEntries = Object.entries(annotation.attributes).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
  )
  const metaParts = [
    `<${annotation.tag}>`,
    annotation.role && annotation.role !== annotation.tag ? annotation.role : null,
    annotation.rect.width > 0 || annotation.rect.height > 0
      ? `${annotation.rect.width} × ${annotation.rect.height}`
      : null,
  ].filter(Boolean)

  return (
    <div className="flex flex-col gap-2 text-small">
      <div className="flex min-w-0 items-start gap-1.5">
        <HugeiconsIcon
          aria-hidden
          icon={Globe02Icon}
          strokeWidth={1.9}
          className="mt-0.5 size-3.5 shrink-0 text-tertiary"
        />
        <div className="min-w-0 flex-1">
          {annotation.pageTitle && (
            <div className="truncate font-medium text-primary">{annotation.pageTitle}</div>
          )}
          <div className="break-all text-caption text-tertiary">{annotation.url}</div>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2 text-caption text-tertiary">
          <span>{t('browserAnnotations.locator')}</span>
          <span className="tabular">{metaParts.join(' · ')}</span>
        </div>
        <div className="rounded-md bg-code-block px-2 py-1.5 font-mono text-caption break-all text-primary">
          {annotation.selector}
        </div>
      </div>

      {annotation.accessibleName && annotation.accessibleName !== annotation.text && (
        <div className="flex flex-col gap-0.5">
          <span className="text-caption text-tertiary">
            {t('browserAnnotations.accessibleName')}
          </span>
          <div className="line-clamp-2 text-hint text-secondary">{annotation.accessibleName}</div>
        </div>
      )}

      {annotation.text && (
        <div className="flex flex-col gap-0.5">
          <span className="text-caption text-tertiary">{t('browserAnnotations.visibleText')}</span>
          <div className="line-clamp-3 rounded-md bg-subtle px-2 py-1.5 text-hint text-primary">
            {annotation.text}
          </div>
        </div>
      )}

      {attrEntries.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <span className="text-caption text-tertiary">{t('browserAnnotations.attributes')}</span>
          <div className="flex flex-col gap-0.5 font-mono text-caption text-secondary">
            {attrEntries.map(([key, value]) => (
              <div key={key} className="truncate">
                <span className="text-tertiary">{key}=</span>
                <span className="text-primary">{JSON.stringify(value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
