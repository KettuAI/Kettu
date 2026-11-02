import { useState } from 'react'
import { GlobeIcon, LockIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { addressText, isLocalHost, normalizeAddress } from './address'

/**
 * The address the page shows, after a lock for a page served over https or from this computer;
 * focusing selects the whole address, and Esc puts back what the page shows.
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

  const secure = url ? isSecure(url) : false

  return (
    <label
      className={cn(
        'app-region-no-drag flex h-7.5 min-w-0 items-center gap-2 rounded-xl bg-subtle px-2.5 text-tertiary transition-[background-color,box-shadow] duration-(--duration-fast)',
        'hover:shadow-[inset_0_0_0_var(--hairline)_var(--border-default)] focus-within:bg-surface focus-within:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]',
        invalid && 'shadow-[inset_0_0_0_var(--hairline)_var(--danger)]!',
        className,
      )}
    >
      {url &&
        (secure ? (
          <LockIcon aria-hidden strokeWidth={1.5} className="size-3.25 shrink-0" />
        ) : (
          <GlobeIcon aria-hidden className="size-3.25 shrink-0" />
        ))}
      <input
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
          // The address starts at its beginning, not where the field was scrolled to.
          event.currentTarget.scrollLeft = 0
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
        className="h-full w-full min-w-0 bg-transparent text-hint text-primary outline-none placeholder:text-placeholder"
      />
    </label>
  )
}

function isSecure(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || isLocalHost(parsed.hostname)
  } catch {
    return false
  }
}
