import { useState, type KeyboardEvent } from 'react'
import {
  ArrowDown01Icon,
  Calendar03Icon,
  LinkSquare02Icon,
  Plug01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { FormField, FormValues, ToolEntry } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { Calendar } from '@renderer/components/ui/calendar'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Switch } from '@renderer/components/ui/switch'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { SettingSelect } from '@renderer/features/settings/controls'
import { openLinkIn } from '../open-link'
import { DATE, fieldError, siteOf } from './elicitation-model'

/** Up to this many choices sit side by side as segments; more go in a list. */
const SEGMENTED_MAX = 5

/** A form's own Esc leaves the field, so it never declines the request on its card. */
function keepEscape(event: KeyboardEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement
  if (event.key !== 'Escape' || !target.closest('input, textarea, [role="combobox"]')) return
  event.stopPropagation()
  target.blur()
}

function DateField({
  value,
  label,
  disabled,
  onChange,
}: {
  value: string
  label: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const { t, i18n } = useTranslation('session')
  const [open, setOpen] = useState(false)
  const date = DATE.test(value) ? new Date(`${value}T00:00:00`) : undefined
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={label}
        className="flex h-8.5 w-56 cursor-default items-center gap-2 rounded-xl border border-input bg-card pr-2.5 pl-2.75 text-left text-row shadow-field transition-[border-color,box-shadow] outline-none hover:enabled:border-strong focus-visible:border-focused focus-visible:shadow-field-focus disabled:opacity-40 data-popup-open:border-focused data-popup-open:shadow-field-focus"
      >
        <span className={cn('min-w-0 flex-1 truncate', !date && 'text-tertiary')}>
          {date
            ? date.toLocaleDateString(i18n.language, { dateStyle: 'medium' })
            : t('elicitation.pickDate')}
        </span>
        <Icon icon={Calendar03Icon} size={15} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={date}
          defaultMonth={date}
          onSelect={(day) => {
            if (!day) return
            const y = day.getFullYear()
            const m = String(day.getMonth() + 1).padStart(2, '0')
            const d = String(day.getDate()).padStart(2, '0')
            onChange(`${y}-${m}-${d}`)
            setOpen(false)
          }}
          className="bg-transparent px-3 py-2.5"
        />
      </PopoverContent>
    </Popover>
  )
}

function FieldControl({
  field,
  value,
  disabled,
  invalid,
  onChange,
}: {
  field: FormField
  value: FormValues[string] | undefined
  disabled: boolean
  invalid: boolean
  onChange: (value: FormValues[string]) => void
}) {
  switch (field.type) {
    case 'boolean':
      return (
        <Switch
          aria-label={field.title}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked)}
        />
      )
    case 'choice':
      if (field.choices.length <= SEGMENTED_MAX) {
        return (
          <SegmentedControl
            aria-label={field.title}
            value={typeof value === 'string' ? value : ''}
            onChange={(next) => onChange(next)}
            segments={field.choices.map((choice) => ({ value: choice.value, label: choice.label }))}
            className="self-start"
          />
        )
      }
      return (
        <SettingSelect
          label={field.title}
          value={typeof value === 'string' ? value : ''}
          options={field.choices.map((choice) => ({ value: choice.value, label: choice.label }))}
          disabled={disabled}
          onChange={(next) => onChange(next)}
          className="w-56"
        />
      )
    case 'choices': {
      const picked = Array.isArray(value) ? value : []
      return (
        <div role="group" aria-label={field.title} className="flex flex-wrap gap-x-4 gap-y-2">
          {field.choices.map((choice) => (
            <label key={choice.value} className="flex items-center gap-2 text-row">
              <Checkbox
                checked={picked.includes(choice.value)}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange(
                    checked ? [...picked, choice.value] : picked.filter((v) => v !== choice.value),
                  )
                }
              />
              {choice.label}
            </label>
          ))}
        </div>
      )
    }
    case 'text':
      if (field.format === 'date') {
        return (
          <DateField
            value={typeof value === 'string' ? value : ''}
            label={field.title}
            disabled={disabled}
            onChange={onChange}
          />
        )
      }
      return (
        <Input
          type={field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : 'text'}
          aria-label={field.title}
          aria-invalid={invalid || undefined}
          value={typeof value === 'string' ? value : ''}
          maxLength={field.maxLength}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="h-8.5 rounded-xl text-row"
        />
      )
    case 'number':
      return (
        <Input
          type="number"
          inputMode={field.integer ? 'numeric' : 'decimal'}
          aria-label={field.title}
          aria-invalid={invalid || undefined}
          value={value === undefined ? '' : String(value)}
          min={field.minimum}
          max={field.maximum}
          step={field.integer ? 1 : 'any'}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="h-8.5 w-40 rounded-xl text-row tabular"
        />
      )
  }
}

/**
 * A form's fields, one row each by type, which the Decision Card above the composer holds; errors
 * show once the user changed the field.
 */
export function ElicitationForm({
  fields,
  draft,
  touched,
  onChange,
}: {
  fields: FormField[]
  draft: Partial<FormValues>
  /** The fields the user changed, whose errors show. */
  touched: Record<string, true>
  onChange: (key: string, value: FormValues[string]) => void
}) {
  const { t } = useTranslation('session')
  return (
    <div className="ks-form" onKeyDownCapture={keepEscape}>
      {fields.map((field) => {
        const shown = touched[field.key] ? fieldError(field, draft[field.key], t) : null
        return (
          <div key={field.key} className="contents">
            <span className="ks-form__label">
              {field.title}
              {!field.required && field.type !== 'boolean' && (
                <span>{t('elicitation.optional')}</span>
              )}
            </span>
            <div className="ks-form__field">
              <FieldControl
                field={field}
                value={draft[field.key]}
                disabled={false}
                invalid={!!shown}
                onChange={(value) => onChange(field.key, value)}
              />
              {field.description && <span className="ks-form__hint">{field.description}</span>}
              {shown && <span className="ks-form__error">{shown}</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * An MCP server's request once answered: a row with the server and what became of it. A form's
 * values open under it; a page still being finished in the browser can be opened again.
 */
export function ElicitationSettled({ entry }: { entry: ToolEntry }) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  const asked = entry.elicitation!
  const result = entry.permissionResult
  const accepted =
    typeof result === 'object' &&
    result !== null &&
    (result.kind === 'allow_once' || result.kind === 'allow_always')
  const fields = typeof result === 'object' && result !== null ? (result.fields ?? []) : []
  const url = asked.kind === 'url' ? (asked.url ?? null) : null
  const finishing = accepted && url !== null && entry.status === 'in_progress'
  const state = finishing
    ? t('elicitation.finishIn', { site: siteOf(url) })
    : accepted
      ? url !== null
        ? t('elicitation.opened', { site: siteOf(url) })
        : t('elicitation.submitted')
      : result === 'cancelled' || result === 'withdrawn'
        ? t('permission.answer.cancelled')
        : result
          ? t('elicitation.declined')
          : t('status.pending')
  return (
    <div data-entry-id={entry.id} className="min-w-0">
      <div className="ks-answered" data-kind={accepted ? 'done' : 'other'}>
        <div className="ks-answered__head ks-answered__head--alone">
          <Icon icon={Plug01Icon} size={16} />
          <span className="ks-answered__title">{asked.server}</span>
          <span className="ks-answered__device">· {state}</span>
          {finishing && <Spinner aria-hidden className="size-3.5 shrink-0" />}
          {finishing && (
            <button
              type="button"
              className="ks-answered__toggle"
              onClick={() => openLinkIn(url, 'browser', null)}
            >
              <Icon icon={LinkSquare02Icon} size={14} />
              {t('elicitation.openAgain')}
            </button>
          )}
          {fields.length > 0 && (
            <button
              type="button"
              className="ks-answered__toggle"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? t('elicitation.hideValues') : t('elicitation.showValues')}
              <Icon icon={ArrowDown01Icon} size={14} />
            </button>
          )}
        </div>
        {open && fields.length > 0 && (
          <dl className="ks-answered__values">
            {fields.map((field, i) => (
              <div key={i} className="contents">
                <dt>{field.title}</dt>
                <dd data-selectable="">{field.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  )
}
