import { useMemo, useState } from 'react'
import { CalendarIcon, ChevronDownIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { enUS, zhCN } from 'react-day-picker/locale'
import { Button } from '@renderer/components/ui/button'
import { Calendar } from '@renderer/components/ui/calendar'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { currentLocale } from '@renderer/lib/i18n'
import { cn } from '@renderer/lib/utils'
import {
  addDays,
  dayOf,
  daysBetween,
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
  label,
  today,
  firstDay,
  first,
  used,
  onApply,
}: {
  /** The custom range applied now, both ends included, or null while a preset range shows. */
  value: { from: number; to: number } | null
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
    if (next) reset(value?.from ?? null, value?.to ?? null)
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
  const fields = typedRange(draft, typed, left, today)
  const ready = fields.range?.from != null
  const type = (which: End, text: string) => {
    const nextTyped = { ...typed, [which]: text }
    const nextLeft = { ...left, [which]: false }
    setTyped(nextTyped)
    setLeft(nextLeft)
    const next = typedRange(draft, nextTyped, nextLeft, today).range
    if (next === null) return
    setDraft(next)
    const day = typedDay(text, today, false)
    if (typeof day === 'number') show(day, which === 'to' ? 'right' : 'left')
  }
  const wrong = (which: End) => {
    const text = typed[which]
    if (fields.error === 'order') return text !== null && text.trim() !== ''
    return text !== null && typeof typedDay(text, today, left[which]) === 'string'
  }

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger
        render={
          <Button
            variant="quiet"
            size="compact"
            aria-pressed={value !== null}
            aria-label={t('picker.label')}
          />
        }
      >
        <CalendarIcon data-icon="inline-start" />
        <span className="tabular-nums">{label ?? t('picker.button')}</span>
        <ChevronDownIcon data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto flex-row gap-0 p-0">
        <div
          role="group"
          aria-label={t('picker.label')}
          className="flex w-32 shrink-0 flex-col gap-px border-r border-border-soft p-1.5"
        >
          {presetList.map((preset: Preset) => (
            <Button
              key={preset.id}
              variant="ghost"
              size="sm"
              aria-pressed={draft.from === preset.from && draft.to === preset.to}
              className="justify-start font-normal aria-pressed:bg-accent aria-pressed:text-foreground"
              onClick={() => reset(preset.from, preset.to)}
            >
              {t(`picker.presets.${preset.id}`)}
            </Button>
          ))}
        </div>
        <div className="flex flex-col">
          <Calendar
            mode="range"
            numberOfMonths={2}
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
            modifiersClassNames={{
              used: 'after:absolute after:bottom-1 after:left-1/2 after:size-1 after:-translate-x-1/2 after:rounded-full after:bg-current after:opacity-50',
            }}
            className="bg-transparent p-3"
          />
          <div className="flex items-center gap-2 border-t border-border-soft px-3 py-2.5">
            <DateField
              label={t('picker.start')}
              value={typed.from ?? (lo !== null ? iso(lo) : '')}
              invalid={wrong('from')}
              onChange={(text) => type('from', text)}
              onBlur={() => setLeft((v) => ({ ...v, from: true }))}
            />
            <span className="text-muted-foreground">–</span>
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
                'min-w-14 text-xs tabular-nums',
                fields.error ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {fields.error
                ? t(`picker.errors.${fields.error}`)
                : count !== null
                  ? t('picker.days', { count })
                  : ''}
            </span>
            <span className="flex-1" />
            <Button variant="ghost" size="compact" onClick={() => setOpen(false)}>
              {t('picker.cancel')}
            </Button>
            <Button
              size="compact"
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
        </div>
      </PopoverContent>
    </Popover>
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
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {label}
      <Input
        value={value}
        placeholder="YYYY-MM-DD"
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        className={cn('h-control w-28 font-mono text-xs tabular-nums')}
        spellCheck={false}
      />
    </label>
  )
}
