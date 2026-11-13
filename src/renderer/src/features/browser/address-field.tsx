import { useState, type Ref } from 'react'
import { Globe02Icon, SquareLock02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { PaneIcon } from '@renderer/features/shell/panel-button'
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
  ref,
}: {
  url: string | null
  onNavigate: (url: string) => void
  className?: string
  autoFocus?: boolean
  ref?: Ref<HTMLInputElement>
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

  const secure = url && !editing ? isSecure(url) : false

  return (
    <label
      className={cn('kp-addr app-region-no-drag', className)}
      data-invalid={invalid || undefined}
    >
      <PaneIcon icon={secure ? SquareLock02Icon : Globe02Icon} size={14} />
      <input
        ref={ref}
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
