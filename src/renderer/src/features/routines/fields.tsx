// What the routines pages share: the strip over the page, and the routine page's form, a group of
// fields to a card, each field a row with its name and what it does beside its control.

import type { ReactNode } from 'react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { CornerControlsSpace } from '@renderer/features/shell/top-bar'
import { hasBand } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useViewStore } from '@renderer/stores/view'

/** The column the routines pages lay out in, between the sheet's gutters. */
export const PAGE_COLUMN = 'mx-auto w-full max-w-270'

/** A card's rows: a line between two, none above the first. */
export const CARD_ROWS = '*:not-first:shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]'

/**
 * The strip of sheet above the page, which drags the window. On macOS with the sidebar collapsed
 * it is a top bar's height, beside the traffic lights, and holds the sidebar toggle.
 */
export function PageStrip() {
  const cornered = useViewStore((s) => s.sidebarCollapsed) && !hasBand
  return (
    <div
      className={cn(
        'app-region-drag flex shrink-0 items-center',
        cornered ? 'h-top-bar pl-(--corner-inset)' : 'h-8',
      )}
    >
      {cornered && <CornerControlsSpace />}
    </div>
  )
}

/** A group's name and a hint after it, over the card that holds it. */
export function GroupHeading({
  title,
  hint,
  className,
  children,
}: {
  title: string
  hint?: ReactNode
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={cn('mb-2.5 flex items-baseline gap-2 px-0.5', className)}>
      <h2 className="text-row font-semibold">{title}</h2>
      {hint !== undefined && <span className="text-hint text-tertiary tabular">{hint}</span>}
      {children}
    </div>
  )
}

/** A group of the routine's fields: its heading over a card of rows. */
export function RoutineSection({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: ReactNode
}) {
  return (
    <section aria-label={title}>
      <GroupHeading title={title} hint={hint} />
      <div className={cn('overflow-hidden rounded-card bg-card shadow-card', CARD_ROWS)}>
        {children}
      </div>
    </section>
  )
}

function FieldLabel({ name, description }: { name: string; description: string }) {
  return (
    <div className="min-w-0">
      <div className="text-lede leading-5 font-medium">{name}</div>
      <div className="mt-px text-hint text-pretty text-tertiary">{description}</div>
    </div>
  )
}

/** One field: its name and what it does, its control at the end, under them when narrow. */
export function FieldRow({
  name,
  description,
  children,
}: {
  name: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="flex min-h-16.5 flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4.5 py-3.5">
      <div className="min-w-50 flex-1 basis-60">
        <FieldLabel name={name} description={description} />
      </div>
      <div className="flex max-w-full min-w-0 shrink-0">{children}</div>
    </div>
  )
}

/** A field whose control takes the card's width under its name, such as the prompt. */
export function FieldBlock({
  name,
  description,
  children,
}: {
  name: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="px-4.5 pt-4 pb-4.5">
      <FieldLabel name={name} description={description} />
      <div className="mt-3">{children}</div>
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
