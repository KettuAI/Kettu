import { useMemo, useState, type ComponentProps } from 'react'
import { CalendarIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { enUS, zhCN } from 'react-day-picker/locale'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Calendar, CalendarDayButton } from '@renderer/components/ui/calendar'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { currentLocale } from '@renderer/lib/i18n'
import { cn } from '@renderer/lib/utils'
import {
  addDays,
  dayOf,
  daysBetween,
  monthStartOf,
  presets,
  typedDay,
  typedRange,
  type Preset,
  type RangeDraft,
} from './model'

type End = 'from' | 'to'

function iso(day: number): string {
  const d = new Date(day)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const ordered = (a: number, b: number): [number, number] => (a <= b ? [a, b] : [b, a])

/**
 * The Custom button and its popover: presets on the left, two months to click a start and an
 * end in either order, and the dates as text below. Nothing changes until Apply.
 */
export function RangePicker({
  value,
  shown,
  label,
  today,
  firstDay,
  first,
  used,
  onApply,
}: {
  /** The custom range applied now, both ends included, or null while a preset range shows. */
  value: { from: number; to: number } | null
  /** The range the page shows, both ends included, which the picker opens with. */
  shown: { from: number; to: number } | null
  /** The button's text for that range. */
  label: string | null
  today: number
  firstDay: number
  /** The first day with usage, which bounds the months. */
  first: number | null
  /** Days with usage, for the dot under their number. */
  used: ReadonlySet<number>
  onApply: (range: { from: number; to: number }) => void
}) {
  const { t } = useTranslation('usage')
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<RangeDraft>({ from: null, to: null })
  const [hover, setHover] = useState<number | null>(null)
  // What is typed in each field; null while it shows the draft's day.
  const [typed, setTyped] = useState<Record<End, string | null>>({ from: null, to: null })
  // Whether each field was left, so a short date is marked as well.
  const [left, setLeft] = useState<Record<End, boolean>>({ from: false, to: false })
  const [month, setMonth] = useState(() => new Date(today))
  // From the first month with usage, and at least last month, so two months always show.
  const todayDate = new Date(today)
  const lastMonth = new Date(todayDate.getFullYear(), todayDate.getMonth() - 1, 1).getTime()
  const startMonth = new Date(
    Math.min(first === null ? addDays(today, -365) : dayOf(first), lastMonth),
  )
  // The first day a click can pick, which a typed day keeps to.
  const earliest = monthStartOf(startMonth.getTime())
  const locale = currentLocale() === 'zh-CN' ? zhCN : enUS
  const presetList = useMemo(() => presets(today, firstDay, first), [today, firstDay, first])

  /** Shows `day` in the right month, or in the left one, within the months there are. */
  const show = (day: number, side: 'left' | 'right') => {
    const date = new Date(day)
    const shown = new Date(date.getFullYear(), date.getMonth() - (side === 'right' ? 1 : 0), 1)
    const latest = new Date(lastMonth)
    setMonth(shown < startMonth ? startMonth : shown > latest ? latest : shown)
  }

  const clearTyped = () => {
    setTyped({ from: null, to: null })
    setLeft({ from: false, to: false })
  }

  const reset = (from: number | null, to: number | null) => {
    setDraft({ from, to })
    setHover(null)
    clearTyped()
    show(to ?? from ?? today, 'right')
  }

  const openChange = (next: boolean) => {
    const start = value ?? shown
    if (next) reset(start?.from ?? null, start?.to ?? null)
    setOpen(next)
  }

  // While only the start is chosen, the day under the pointer previews the end.
  const end = draft.to ?? (draft.from !== null ? hover : null) ?? draft.from
  const [lo, hi] = draft.from !== null && end !== null ? ordered(draft.from, end) : [null, null]
  const count = lo !== null && hi !== null ? daysBetween(lo, hi) + 1 : null

  const pick = (day: number) => {
    if (draft.from === null || draft.to !== null) setDraft({ from: day, to: null })
    else {
      const [from, to] = ordered(draft.from, day)
      setDraft({ from, to })
    }
    clearTyped()
  }

  // What is typed stays as typed; the draft follows once the fields make a range.
  const fields = typedRange(draft, typed, left, today, earliest)
  const ready = fields.range?.from != null
  const type = (which: End, text: string) => {
    const nextTyped = { ...typed, [which]: text }
    const nextLeft = { ...left, [which]: false }
    setTyped(nextTyped)
    setLeft(nextLeft)
    const next = typedRange(draft, nextTyped, nextLeft, today, earliest).range
    if (next === null) return
    setDraft(next)
    const day = typedDay(text, today, false, earliest)
    if (typeof day === 'number') show(day, which === 'to' ? 'right' : 'left')
  }
  const wrong = (which: End) => {
    const text = typed[which]
    if (fields.error === 'order') return text !== null && text.trim() !== ''
    return text !== null && typeof typedDay(text, today, left[which], earliest) === 'string'
  }

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="compact"
            aria-pressed={value !== null}
            aria-label={t('picker.label')}
            className="aria-pressed:shadow-outline-hover"
          />
        }
      >
        <CalendarIcon data-icon="inline-start" className="size-3.5 text-tertiary" />
        <span className="tabular-nums">{label ?? t('picker.button')}</span>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-auto gap-0 p-0">
        <div className="flex">
          <div
            role="group"
            aria-label={t('picker.label')}
            className="flex w-36 shrink-0 flex-col gap-px px-2 py-2.5 shadow-[inset_calc(-1*var(--hairline))_0_0_var(--border-subtle)]"
          >
            {presetList.map((preset: Preset) => (
              <Button
                key={preset.id}
                variant="ghost"
                size="sm"
                aria-pressed={draft.from === preset.from && draft.to === preset.to}
                className="h-7.5 justify-start font-normal text-secondary hover:bg-hover aria-pressed:bg-selected aria-pressed:font-medium aria-pressed:text-foreground"
                onClick={() => reset(preset.from, preset.to)}
              >
                {t(`picker.presets.${preset.id}`)}
              </Button>
            ))}
          </div>
          <Calendar
            mode="range"
            numberOfMonths={2}
            showOutsideDays={false}
            locale={locale}
            weekStartsOn={firstDay as 0 | 1 | 2 | 3 | 4 | 5 | 6}
            month={month}
            onMonthChange={setMonth}
            startMonth={startMonth}
            endMonth={new Date(today)}
            disabled={{ after: new Date(today) }}
            selected={lo !== null ? { from: new Date(lo), to: new Date(hi!) } : undefined}
            onSelect={(_, day) => pick(dayOf(day.getTime()))}
            onDayMouseEnter={(day) => setHover(dayOf(day.getTime()))}
            onDayMouseLeave={() => setHover(null)}
            modifiers={{ used: (date) => used.has(dayOf(date.getTime())) }}
            components={{ DayButton: UsedDay }}
            classNames={CALENDAR}
            className="bg-transparent px-4 py-3 [--cell-radius:var(--radius-lg)] [--cell-size:--spacing(8.5)]"
          />
        </div>
        <div className="flex items-center gap-2 px-3 py-2.5 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]">
          <DateField
            label={t('picker.start')}
            value={typed.from ?? (lo !== null ? iso(lo) : '')}
            invalid={wrong('from')}
            onChange={(text) => type('from', text)}
            onBlur={() => setLeft((v) => ({ ...v, from: true }))}
          />
          <span aria-hidden className="text-tertiary">
            –
          </span>
          <DateField
            label={t('picker.end')}
            value={typed.to ?? (hi !== null && draft.to !== null ? iso(hi) : '')}
            invalid={wrong('to')}
            onChange={(text) => type('to', text)}
            onBlur={() => setLeft((v) => ({ ...v, to: true }))}
          />
          <span
            aria-live="polite"
            className={cn(
              'ml-1.5 min-w-14 text-command tabular-nums',
              fields.error ? 'text-danger' : 'text-tertiary',
            )}
          >
            {fields.error
              ? t(`picker.errors.${fields.error}`, { day: iso(earliest) })
              : count !== null
                ? t('picker.days', { count })
                : t('picker.pickStart')}
          </span>
          <span className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            {t('picker.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={!ready}
            onClick={() => {
              if (!ready || lo === null) return
              // A start without an end applies as that one day.
              onApply({ from: lo, to: draft.to === null ? lo : hi! })
              setOpen(false)
            }}
          >
            {t('picker.apply')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

const MONTH_BUTTON = buttonVariants({
  variant: 'ghost',
  size: 'icon-sm',
  className: 'select-none aria-disabled:opacity-50',
})

/** The calendar as the picker draws it: months in the serif, the chosen range in the selection. */
const CALENDAR = {
  months: 'relative flex gap-7',
  month: 'flex w-full flex-col gap-2',
  button_previous: MONTH_BUTTON,
  button_next: MONTH_BUTTON,
  month_caption: 'flex h-7 w-full items-center justify-center px-7',
  caption_label: 'font-heading text-group font-semibold select-none',
  weekdays: 'mb-0.5 flex',
  weekday: 'flex-1 text-meta leading-5 font-normal text-tertiary select-none',
  week: 'mt-0.5 flex w-full',
  // Wider than tall, and square at a row's ends, so a range reads as one band across its weeks.
  day: 'group/day relative h-8 w-full p-0 text-center select-none',
  day_button:
    'aspect-auto h-8 text-small font-normal tabular-nums hover:bg-hover data-[range-middle=true]:bg-selected',
  today: 'font-semibold [&_button]:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]',
  range_start:
    'relative isolate z-0 rounded-l-(--cell-radius) bg-selected after:absolute after:inset-y-0 after:right-0 after:w-4 after:bg-selected',
  range_end:
    'relative isolate z-0 rounded-r-(--cell-radius) bg-selected after:absolute after:inset-y-0 after:left-0 after:w-4 after:bg-selected',
}

/** A day's button, with a dot under the number on a day with usage. */
function UsedDay(props: ComponentProps<typeof CalendarDayButton>) {
  const { modifiers, children } = props
  const end = modifiers.range_start || modifiers.range_end
  return (
    <CalendarDayButton {...props}>
      {children}
      {modifiers.used && (
        <i
          aria-hidden
          className={cn(
            'absolute bottom-1 left-1/2 size-1 -translate-x-1/2 rounded-full',
            end ? 'bg-primary-foreground' : 'bg-heat-4',
          )}
        />
      )}
    </CalendarDayButton>
  )
}

function DateField({
  label,
  value,
  invalid,
  onChange,
  onBlur,
}: {
  label: string
  value: string
  invalid: boolean
  onChange: (text: string) => void
  onBlur: () => void
}) {
  return (
    <label className="flex items-center">
      <span className="sr-only">{label}</span>
      <Input
        value={value}
        placeholder="YYYY-MM-DD"
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        className="h-7.5 w-29.5 font-mono text-command tabular-nums md:text-command"
        spellCheck={false}
      />
    </label>
  )
}
