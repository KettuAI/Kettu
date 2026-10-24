import type { RefObject } from 'react'
import { SearchIcon, XIcon } from 'lucide-react'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@renderer/components/ui/input-group'
import { Kbd } from '@renderer/components/ui/kbd'
import { formatShortcut } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'

/**
 * A page's search or filter field, focused with `Mod+F` by the page that holds it. `Esc` clears
 * it, then leaves it.
 */
export function SearchField({
  value,
  onChange,
  label,
  clearLabel,
  inputRef,
  className,
}: {
  value: string
  onChange: (value: string) => void
  /** The placeholder and the field's name. */
  label: string
  clearLabel: string
  inputRef: RefObject<HTMLInputElement | null>
  className?: string
}) {
  return (
    <InputGroup className={cn('h-control bg-card shadow-outline', className)}>
      <InputGroupAddon>
        <SearchIcon className="size-3.5" />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        value={value}
        placeholder={label}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (value) onChange('')
          else event.currentTarget.blur()
        }}
        className="text-ui"
      />
      <InputGroupAddon align="inline-end">
        {value ? (
          <button
            type="button"
            aria-label={clearLabel}
            onClick={() => {
              onChange('')
              inputRef.current?.focus()
            }}
            className="flex size-5 items-center justify-center rounded-md hover:bg-hover hover:text-primary"
          >
            <XIcon className="size-3" />
          </button>
        ) : (
          <Kbd className="h-auto bg-transparent p-0 font-normal">{formatShortcut('Mod+F')}</Kbd>
        )}
      </InputGroupAddon>
    </InputGroup>
  )
}
