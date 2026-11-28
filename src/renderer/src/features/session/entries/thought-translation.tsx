import { memo, useCallback } from 'react'
import { AlertCircleIcon, LanguageSkillIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import {
  thoughtTranslationOf,
  useThoughtTranslationsStore,
  type ThoughtTranslateRequester,
} from '@renderer/stores/thought-translations'
import { Clamp } from '../clamp'
import { Markdown } from '../markdown'
import { EntryIdContext, SessionIdContext } from '../media/grants'

export interface ThoughtSummaryViewProps {
  sessionId: string
  entryId: string
  markdown: string
  streaming: boolean
  maxHeight: number
  className?: string
  /** Test hook for overriding the RPC requester. */
  requester?: ThoughtTranslateRequester
}

/**
 * Renders an agent thinking summary with manual on-demand translation and an instant
 * Original / Translation toggle. Defaults to the original text and never auto-translates.
 */
export const ThoughtSummaryView = memo(function ThoughtSummaryView({
  sessionId,
  entryId,
  markdown,
  streaming,
  maxHeight,
  className,
  requester,
}: ThoughtSummaryViewProps) {
  const { t, i18n } = useTranslation(['session', 'common'])
  const language = i18n.language || 'en'
  const record = useThoughtTranslationsStore((s) =>
    thoughtTranslationOf(s.records, sessionId, entryId, markdown, language),
  )
  const translate = useThoughtTranslationsStore((s) => s.translate)
  const setView = useThoughtTranslationsStore((s) => s.setView)

  const hasText = markdown.trim() !== ''
  const canTranslate = hasText && !streaming
  const showingTranslation =
    canTranslate &&
    record.status === 'translated' &&
    record.view === 'translation' &&
    record.translation !== null
  const displayedMarkdown = showingTranslation ? record.translation! : markdown

  const handleTranslate = useCallback(() => {
    void translate(sessionId, entryId, markdown, language, requester)
  }, [translate, sessionId, entryId, markdown, language, requester])

  const handleSelectOriginal = useCallback(() => {
    setView(sessionId, entryId, markdown, language, 'original')
  }, [setView, sessionId, entryId, markdown, language])

  const handleSelectTranslation = useCallback(() => {
    setView(sessionId, entryId, markdown, language, 'translation')
  }, [setView, sessionId, entryId, markdown, language])

  return (
    <div
      data-selectable=""
      data-thought-view-mode={showingTranslation ? 'translation' : 'original'}
      className={cn('text-muted-foreground', className)}
    >
      {canTranslate && (
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          {showingTranslation && (
            <Badge variant="neutral" data-thought-translated-badge="">
              {t('thoughtTranslation.translated')}
            </Badge>
          )}
          {record.status !== 'error' && (
            <div className="ml-auto flex items-center gap-1.5">
              {record.status === 'translated' ? (
                <div
                  role="group"
                  aria-label={t('thoughtTranslation.switchLabel')}
                  data-thought-toggle=""
                  className="inline-flex items-center gap-0.5 rounded-md bg-subtle p-0.5"
                >
                  <button
                    type="button"
                    aria-pressed={record.view === 'original'}
                    data-thought-view="original"
                    className={cn(
                      'inline-flex h-5 items-center rounded-sm px-2 text-caption font-medium transition-colors outline-none focus-ring',
                      record.view === 'original'
                        ? 'bg-raised text-foreground shadow-segment'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={handleSelectOriginal}
                  >
                    {t('thoughtTranslation.original')}
                  </button>
                  <button
                    type="button"
                    aria-pressed={record.view === 'translation'}
                    data-thought-view="translation"
                    className={cn(
                      'inline-flex h-5 items-center rounded-sm px-2 text-caption font-medium transition-colors outline-none focus-ring',
                      record.view === 'translation'
                        ? 'bg-raised text-foreground shadow-segment'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={handleSelectTranslation}
                  >
                    {t('thoughtTranslation.translation')}
                  </button>
                </div>
              ) : record.status === 'loading' ? (
                <Button
                  variant="quiet"
                  size="xs"
                  disabled
                  aria-busy="true"
                  className="h-5.5 gap-1 px-1.5 text-caption"
                  data-thought-translating=""
                >
                  <Spinner className="size-3" />
                  <span>{t('thoughtTranslation.translating')}</span>
                </Button>
              ) : (
                <Button
                  variant="quiet"
                  size="xs"
                  className="h-5.5 gap-1 px-1.5 text-caption"
                  data-thought-translate=""
                  onClick={handleTranslate}
                >
                  <HugeiconsIcon
                    icon={LanguageSkillIcon}
                    strokeWidth={1.9}
                    aria-hidden
                    className="size-3 shrink-0"
                  />
                  <span>{t('thoughtTranslation.translate')}</span>
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {canTranslate && record.status === 'error' && (
        <div
          role="alert"
          data-thought-error=""
          className="mb-1.5 flex items-center justify-between gap-2 rounded-lg bg-danger-tint px-2.5 py-1.5 text-xs text-danger"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <HugeiconsIcon
              icon={AlertCircleIcon}
              strokeWidth={1.9}
              aria-hidden
              className="size-3.5 shrink-0"
            />
            <span className="min-w-0 break-words">
              {record.error || t('thoughtTranslation.failed')}
            </span>
          </span>
          <Button size="xs" variant="outline" data-thought-retry="" onClick={handleTranslate}>
            {t('common:actions.retry')}
          </Button>
        </div>
      )}
      <SessionIdContext value={sessionId}>
        <EntryIdContext value={entryId}>
          <Clamp maxHeight={maxHeight} buttonClassName="-mx-1.5">
            <div className="min-w-0">
              <Markdown
                markdown={displayedMarkdown}
                streaming={showingTranslation ? false : streaming}
                className="markdown-muted markdown-thought"
              />
            </div>
          </Clamp>
        </EntryIdContext>
      </SessionIdContext>
    </div>
  )
})
