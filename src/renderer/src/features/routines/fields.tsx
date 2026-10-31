// What the routines pages share: serif headings over lined rows, and the routine page's form, each
// field a row with its name and what it does on the left and its control on the right, under them
// when the column is narrow.

import type { ReactNode } from 'react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { cn } from '@renderer/lib/utils'

/** A heading's line over a group, with a line under it that the first row sits on. */
export const HEADING = 'flex h-9 items-baseline gap-2 border-b border-subtle'

/** A row's place in a list: the line under it, across the column, except under the last. */
export const ROW_SLOT =
  'relative after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-(--hairline) after:bg-border-soft last:after:hidden'

export function RoutineSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-9">
      <div className={HEADING}>
        <h2 className="font-heading text-heading font-medium">{title}</h2>
      </div>
      {children}
    </section>
  )
}

/** One field: a line under it, except under its section's last. */
export function FieldRow({
  name,
  description,
  wide = false,
  children,
}: {
  name: string
  description: string
  /** A control taller than the text beside it, which starts at the text's top. */
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-subtle py-4 last:border-b-0 @lg/routine:flex-row @lg/routine:gap-6">
      <div className="@lg/routine:w-50 @lg/routine:shrink-0">
        <div className="text-ui font-medium">{name}</div>
        <div className="mt-0.75 text-xs leading-normal text-pretty text-secondary">
          {description}
        </div>
      </div>
      <div className={cn('flex min-w-0 flex-1', wide ? 'items-start' : 'items-center')}>
        {children}
      </div>
    </div>
  )
}

/** A control the form frames as its fields, such as New session's menus on a routine's page. */
export function FieldFrame({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full min-w-0 rounded-lg bg-card shadow-outline transition-shadow duration-(--duration-fast) hover:shadow-outline-hover">
      {children}
    </span>
  )
}

/** A choice from a short list, framed as the form's other fields are. */
export function FieldSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <Select
      value={value}
      items={options}
      onValueChange={(next) => {
        if (next !== null && next !== value) onChange(next as T)
      }}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue>
          {(current: T) => options.find((option) => option.value === current)?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
