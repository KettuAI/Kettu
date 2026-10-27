import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { addressParts, addressText, normalizeAddress } from './address'

/**
 * The address the page shows. The host leads in the primary color and the rest follows in the
 * tertiary one; focusing selects the whole address, and Esc puts back what the page shows.
 */
export function AddressField({
  url,
  onNavigate,
  className,
  autoFocus,
}: {
  url: string | null
  onNavigate: (url: string) => void
  className?: string
  autoFocus?: boolean
}) {
  const { t } = useTranslation('browser')
  const shown = (url ? addressText(url) : '') ?? ''
  const [text, setText] = useState(shown)
  const [editing, setEditing] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const overlay = useRef<HTMLSpanElement>(null)

  // While the field does not have focus, it follows the page.
  if (!editing && text !== shown) setText(shown)

  const finish = () => {
    const url = normalizeAddress(text)
    if (!url) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    onNavigate(url)
  }

  const parts = editing ? null : url ? addressParts(url) : null

  return (
    <div className={cn('app-region-no-drag relative min-w-0', className)}>
      {parts && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center overflow-hidden px-2.5 text-command whitespace-nowrap"
        >
          <span ref={overlay} className="block">
            <span className="text-primary">{parts.host}</span>
            <span className="text-tertiary">{parts.rest}</span>
          </span>
        </span>
      )}
      <input
        ref={input}
        autoFocus={autoFocus}
        aria-label={t('address.label')}
        aria-invalid={invalid || undefined}
        title={invalid ? t('address.invalid') : undefined}
        placeholder={t('address.placeholder')}
        value={text}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(event) => {
          setText(event.currentTarget.value)
          setInvalid(false)
        }}
        onFocus={(event) => {
          setEditing(true)
          event.currentTarget.select()
        }}
        onBlur={(event) => {
          setEditing(false)
          setInvalid(false)
          setText(shown)
          // The colored address starts at its beginning, not where the field was scrolled to.
          event.currentTarget.scrollLeft = 0
        }}
        onScroll={(event) => {
          if (overlay.current) {
            overlay.current.style.transform = `translateX(-${event.currentTarget.scrollLeft}px)`
          }
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Enter') {
            event.preventDefault()
            finish()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setText(shown)
            setInvalid(false)
            event.currentTarget.blur()
          }
        }}
        className={cn(
          'h-7 w-full min-w-0 rounded-lg bg-subtle px-2.5 text-command text-primary outline-none transition-[background-color,box-shadow] duration-(--duration-fast)',
          'hover:ring-1 hover:ring-border hover:ring-inset focus:bg-surface focus:ring-1 focus:ring-border-strong focus:ring-inset',
          !editing && 'text-transparent caret-transparent',
          invalid && 'ring-1 ring-danger ring-inset hover:ring-danger focus:ring-danger',
        )}
      />
    </div>
  )
}
