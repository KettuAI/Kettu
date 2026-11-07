import { useRef, useState, type KeyboardEvent, type Ref } from 'react'
import {
  ArrowDown01Icon,
  Calendar03Icon,
  Globe02Icon,
  LinkSquare02Icon,
  Plug01Icon,
} from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { getDomain } from 'tldts'
import { useTranslation } from 'react-i18next'
import type { FormField, FormValues, PendingElicitation, ToolEntry } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Icon } from '@renderer/components/affect/app-shell'
import { ApprovalCard } from '@renderer/components/affect/approval-card'
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
import { respondToPermission, respondWithValues } from './helpers'
import { useAnswering } from './use-answering'

/** Up to this many choices sit side by side as segments; more go in a list. */
const SEGMENTED_MAX = 5

/** A form's own Esc leaves the field, so it never declines the request on its card. */
function keepEscape(event: KeyboardEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement
  if (event.key !== 'Escape' || !target.closest('input, textarea, [role="combobox"]')) return
  event.stopPropagation()
  target.blur()
}

/** The address a link goes to, http and https only; null for anything else. */
function webUrl(url: string): URL | null {
  const parsed = URL.parse(url)
  return parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed : null
}

/** The site a link names: its registrable domain, or its host where it has none. */
function siteOf(url: string): string {
  const parsed = webUrl(url)
  if (!parsed) return url
  return getDomain(parsed.hostname) ?? parsed.hostname
}

/** Each field's starting value: the server's default, or empty. */
function startValues(fields: FormField[]): Partial<FormValues> {
  const values: Partial<FormValues> = {}
  for (const field of fields) {
    if (field.default !== undefined) values[field.key] = field.default
    else if (field.type === 'boolean') values[field.key] = false
    else if (field.type === 'choices') values[field.key] = []
  }
  return values
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Why a field's value cannot go, or null; the host checks the same again. */
function fieldError(
  field: FormField,
  value: FormValues[string] | undefined,
  t: TFunction<'session'>,
): string | null {
  const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
  if (empty) return field.required ? t('elicitation.required') : null
  switch (field.type) {
    case 'text': {
      const text = String(value)
      if (field.minLength !== undefined && text.length < field.minLength) {
        return t('elicitation.tooShort', { count: field.minLength })
      }
      if (field.maxLength !== undefined && text.length > field.maxLength) {
        return t('elicitation.tooLong', { count: field.maxLength })
      }
      if (field.format === 'email' && !EMAIL.test(text)) return t('elicitation.notEmail')
      if (field.format === 'uri' && !webUrl(text)) return t('elicitation.notUrl')
      if (field.format === 'date' && !DATE.test(text)) return t('elicitation.notDate')
      return null
    }
    case 'number': {
      const n = Number(value)
      if (!Number.isFinite(n) || (field.integer && !Number.isInteger(n))) {
        return t(field.integer ? 'elicitation.notInteger' : 'elicitation.notNumber')
      }
      if (field.minimum !== undefined && n < field.minimum) {
        return t('elicitation.atLeast', { value: field.minimum })
      }
      if (field.maximum !== undefined && n > field.maximum) {
        return t('elicitation.atMost', { value: field.maximum })
      }
      return null
    }
    case 'choices': {
      const count = (value as string[]).length
      if (field.minItems !== undefined && count < field.minItems) {
        return t('elicitation.pickAtLeast', { count: field.minItems })
      }
      if (field.maxItems !== undefined && count > field.maxItems) {
        return t('elicitation.pickAtMost', { count: field.maxItems })
      }
      return null
    }
    default:
      return null
  }
}

/** The values as the host takes them: numbers as numbers, empty optional fields left out. */
function toValues(fields: FormField[], draft: Partial<FormValues>): FormValues {
  const values: FormValues = {}
  for (const field of fields) {
    const value = draft[field.key]
    if (value === undefined || value === '') continue
    if (Array.isArray(value) && value.length === 0 && !field.required) continue
    values[field.key] = field.type === 'number' ? Number(value) : value
  }
  return values
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
 * An MCP server's request through the agent: a form to fill in, or a page to open. The answer
 * goes back to the server; nothing goes until the user confirms.
 */
export function ElicitationCard({
  ref,
  sessionId,
  entry,
  agentName,
  className,
}: {
  ref: Ref<HTMLDivElement>
  sessionId: string
  entry: ToolEntry
  agentName: string
  className?: string
}) {
  const permission = entry.permission!
  const request = permission.elicitation!
  return request.kind === 'form' ? (
    <FormCard
      ref={ref}
      sessionId={sessionId}
      entry={entry}
      request={request}
      agentName={agentName}
      className={className}
    />
  ) : (
    <LinkCard
      ref={ref}
      sessionId={sessionId}
      entry={entry}
      request={request}
      agentName={agentName}
      className={className}
    />
  )
}

function FormCard({
  ref,
  sessionId,
  entry,
  request,
  agentName,
  className,
}: {
  ref: Ref<HTMLDivElement>
  sessionId: string
  entry: ToolEntry
  request: Extract<PendingElicitation, { kind: 'form' }>
  agentName: string
  className?: string
}) {
  const { t } = useTranslation('session')
  const permission = entry.permission!
  const [draft, setDraft] = useState(() => startValues(request.fields))
  const [tried, setTried] = useState(false)
  const { answering, error, away, send } = useAnswering(sessionId)
  const body = useRef<HTMLDivElement>(null)
  const busy = away || answering !== null
  const decline = permission.options.find((o) => o.kind === 'reject_once')
  const errors = request.fields.map((field) => fieldError(field, draft[field.key], t))
  const ready = errors.every((e) => e === null)

  const submit = async () => {
    if (busy) return
    setTried(true)
    if (!ready) return
    const focused = !!body.current?.contains(document.activeElement)
    const sent = await send('submit', () =>
      respondWithValues(sessionId, permission.requestId, toValues(request.fields, draft)),
    )
    if (sent && focused) emitAppEvent({ kind: 'focus-composer' })
  }

  const declineIt = () => {
    if (!decline || busy) return
    void send(decline.id, () => respondToPermission(sessionId, permission.requestId, decline.id))
  }

  return (
    <div ref={ref} data-entry-id={entry.id} className={cn('min-w-0', className)}>
      <div ref={body} className="min-w-0" onKeyDownCapture={keepEscape}>
        <ApprovalCard
          className="ks-plan"
          title={request.server}
          description={t('elicitation.inAgent', { agent: agentName })}
          icon={<Icon icon={Plug01Icon} size={15} />}
          label={t('question.asksYou')}
          approveLabel={t('elicitation.submit')}
          denyLabel={t('elicitation.decline')}
          allowAlways={false}
          shortcuts
          status="pending"
          onApprove={async () => {
            await submit()
            // A form that is not ready, or an answer that did not go, keeps the card waiting.
            if (!ready) throw new Error('not ready')
          }}
          onDeny={declineIt}
          preview={
            <div className="ks-plan__preview">
              {request.message && (
                <p data-selectable="" className="ks-form__message">
                  {request.message}
                </p>
              )}
              <div className="ks-form">
                {request.fields.map((field, i) => {
                  const shown = tried ? errors[i] : null
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
                          disabled={busy}
                          invalid={!!shown}
                          onChange={(value) => setDraft((d) => ({ ...d, [field.key]: value }))}
                        />
                        {field.description && (
                          <span className="ks-form__hint">{field.description}</span>
                        )}
                        {shown && <span className="ks-form__error">{shown}</span>}
                      </div>
                    </div>
                  )
                })}
              </div>
              <span className="ks-plan__label">
                {t('elicitation.sentTo', { server: request.server })}
              </span>
            </div>
          }
        />
      </div>
      {error && (
        <p role="alert" className="ks-card-error">
          {error}
        </p>
      )}
    </div>
  )
}

function LinkCard({
  ref,
  sessionId,
  entry,
  request,
  agentName,
  className,
}: {
  ref: Ref<HTMLDivElement>
  sessionId: string
  entry: ToolEntry
  request: Extract<PendingElicitation, { kind: 'url' }>
  agentName: string
  className?: string
}) {
  const { t } = useTranslation('session')
  const permission = entry.permission!
  const { answering, error, away, send } = useAnswering(sessionId)
  const busy = away || answering !== null
  const accept = permission.options.find((o) => o.kind === 'allow_once')
  const decline = permission.options.find((o) => o.kind === 'reject_once')
  const site = siteOf(request.url)
  const usable = webUrl(request.url) !== null

  const open = async () => {
    if (busy || !accept || !usable) return
    const sent = await send(accept.id, () =>
      respondToPermission(sessionId, permission.requestId, accept.id),
    )
    if (sent) openLinkIn(request.url, 'browser', null)
  }

  return (
    <div ref={ref} data-entry-id={entry.id} className={cn('min-w-0', className)}>
      <ApprovalCard
        className="ks-plan"
        title={request.server}
        description={t('elicitation.inAgent', { agent: agentName })}
        icon={<Icon icon={Plug01Icon} size={15} />}
        label={t('question.asksYou')}
        approveLabel={t('elicitation.open', { site })}
        denyLabel={t('elicitation.decline')}
        allowAlways={false}
        shortcuts
        status="pending"
        onApprove={async () => {
          await open()
          if (!usable || !accept) throw new Error('not usable')
        }}
        onDeny={() => {
          if (!decline || busy) return
          void send(decline.id, () =>
            respondToPermission(sessionId, permission.requestId, decline.id),
          )
        }}
        preview={
          <div className="ks-plan__preview">
            {request.message && (
              <p data-selectable="" className="ks-form__message">
                {request.message}
              </p>
            )}
            <div className="ks-link">
              <Icon icon={Globe02Icon} size={16} />
              <span className="ks-link__text">
                <b>{site}</b>
                <span data-selectable="">{request.url}</span>
              </span>
            </div>
            <span className="ks-plan__label">{t('elicitation.opensInBrowser')}</span>
          </div>
        }
      />
      {error && (
        <p role="alert" className="ks-card-error">
          {error}
        </p>
      )}
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
