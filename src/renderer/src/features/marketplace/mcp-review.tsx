import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { McpDiscovery, McpDiscoveryRow, McpImportChoice } from '@shared/mcp-discovery'
import { MARKET_NAME } from '@shared/marketplace'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { DialogClose } from '@renderer/components/ui/dialog'
import { Textarea } from '@renderer/components/ui/textarea'
import { TextField } from '@renderer/components/affect/text-field'
import { SetButton } from '@renderer/features/settings/controls'
import {
  SettingsDialogBody,
  SettingsDialogFooter,
} from '@renderer/features/settings/settings-dialog'
import { toast } from '@renderer/components/ui/toast'
import { useHostScope } from '@renderer/stores/host-scope'
import { useAgentName } from './hooks'
import { AgentPicker } from './install'
import { homeShort } from './model'
import { McpConfirmation, McpRunPreview } from './mcp-confirmation'

export function SourceLabel({ source }: { source: McpDiscoveryRow['sources'][number] }) {
  const { t } = useTranslation('marketplace')
  const agentName = useAgentName()
  return (
    <span className="k-mcp-source">
      <span>{source.agentId ? agentName(source.agentId) : (source.app ?? t('mcp.project'))}</span>
      <code className="k-mkt-mono">{homeShort(source.path)}</code>
      {source.keys.length > 0 && (
        <span>{t('mcp.sourceKeys', { keys: source.keys.join(', ') })}</span>
      )}
    </span>
  )
}

export function McpFileErrors({ errors }: { errors: McpDiscovery['errors'] }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  return errors.map(({ reason, source, line }, index) => (
    <div className="k-mcp-file-error" key={source.path + ':' + index}>
      <span>
        {t('mcp.fileError', {
          path: homeShort(source.path),
          reason: t(`mcp.files.${reason}`, { line }),
        })}
      </span>
      <SetButton size="sm" variant="ghost" onClick={() => void scope.api.showItem(source.path)}>
        {t('mcp.showFile')}
      </SetButton>
    </div>
  ))
}

interface ChoiceRow extends McpImportChoice {
  checked: boolean
  copy: boolean
}

function draft(row: McpDiscoveryRow, checked: boolean, copy = false): ChoiceRow {
  return {
    id: row.id,
    name: copy || row.nameConflict ? '' : row.name,
    agents: 'all',
    checked: checked && row.differentKeys.length === 0 && !row.nameConflict && !copy,
    copy,
    another: copy || row.existing.length > 0,
  }
}

function ReviewRow({
  row,
  choice,
  change,
  addCopy,
  blockedSources,
  add,
}: {
  row: McpDiscoveryRow
  choice: ChoiceRow
  change(patch: Partial<ChoiceRow>): void
  addCopy?: () => void
  blockedSources: string[]
  add: boolean
}) {
  const { t } = useTranslation('marketplace')
  const agentName = useAgentName()
  const conflict = row.differentKeys.length > 0
  const chosen = row.sources.find((source) => source.id === choice.sourceId)
  const keyCount = row.sources.length
  return (
    <section className="k-mcp-review-row">
      <header className="k-mcp-review-header">
        <label>
          {!add && (
            <Checkbox
              checked={choice.checked}
              disabled={conflict && !choice.sourceId}
              onCheckedChange={(checked) => change({ checked: checked === true })}
            />
          )}
          <strong>{row.name}</strong>
        </label>
        {addCopy && (
          <SetButton variant="ghost" size="sm" onClick={addCopy}>
            {t('mcp.another')}
          </SetButton>
        )}
      </header>
      {conflict && (
        <p className="k-mcp-warning">
          {t('mcp.differentKeys', { count: keyCount })} · {row.differentKeys.join(', ')}
        </p>
      )}
      {!add &&
        (conflict ? (
          <fieldset className="k-mcp-sources">
            <legend className="sr-only">{t('mcp.chooseSource')}</legend>
            {row.sources.map((source) => (
              <label key={source.id} className="k-mcp-source-option">
                <input
                  type="radio"
                  className="focus-ring accent-primary"
                  name={row.id + (choice.copy ? '-another' : '')}
                  checked={choice.sourceId === source.id}
                  disabled={source.imported || blockedSources.includes(source.id)}
                  onChange={() =>
                    change({
                      sourceId: source.id,
                      ...(!choice.copy &&
                      !row.nameConflict &&
                      (!chosen || choice.name === chosen.name)
                        ? { name: source.name, checked: false }
                        : {}),
                    })
                  }
                />
                <SourceLabel source={source} />
              </label>
            ))}
          </fieldset>
        ) : (
          <div className="k-mcp-sources">
            {row.sources.map((source) => (
              <SourceLabel key={source.id} source={source} />
            ))}
          </div>
        ))}
      {row.sources.some(({ keys }) => keys.length > 0) && (
        <p className="k-mcp-warning">{t('mcp.movesKeys')}</p>
      )}
      {(!conflict || chosen) && (
        <McpRunPreview
          spec={chosen?.spec ?? row.spec}
          project={chosen?.project ?? row.sources[0]?.project}
        />
      )}
      {(add || row.nameConflict || choice.copy || (chosen && chosen.name !== row.name)) && (
        <TextField
          size="sm"
          label={t(add ? 'mcp.name' : 'mcp.importAs')}
          value={choice.name}
          onChange={(event) => change({ name: event.target.value })}
        />
      )}
      {row.nameConflict && !add && !choice.copy && (
        <p className="k-mcp-warning">{t('mcp.renameConflict')}</p>
      )}
      <details className="k-mcp-agent-picker">
        <summary className="focus-ring">
          {t('install.useIn')} ·{' '}
          {choice.agents === 'all'
            ? t('install.allAgents')
            : choice.agents.map(agentName).join(', ')}
        </summary>
        <AgentPicker
          value={choice.agents}
          onChange={(agents) => change({ agents })}
          label={t('install.useIn')}
        />
      </details>
    </section>
  )
}

function ReviewChoices({
  rows,
  add,
  given,
  children,
  onDone,
}: {
  rows: McpDiscoveryRow[]
  add: boolean
  given?: string
  children?: ReactNode
  onDone(): void
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const [picks, setPicks] = useState(() =>
    rows
      .filter((row) => add || row.existing.length === 0 || row.id === given)
      .map((row) => draft(row, !given || row.id === given, row.existing.length > 0)),
  )
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const kept = scope.useSettingsStore((s) => s.settings.marketplace.mcp)
  const names = new Set(kept.map(({ name }) => name))
  const selected = picks.filter(({ checked }) => add || checked)
  const valid =
    selected.length > 0 &&
    selected.every(({ name }) => {
      const ok = MARKET_NAME.test(name) && name !== 'kettu' && !names.has(name)
      names.add(name)
      return ok
    })
  const change = (index: number, patch: Partial<ChoiceRow>) => {
    setPicks((current) => current.map((pick, i) => (i === index ? { ...pick, ...patch } : pick)))
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setFailed(false)
    try {
      await scope.request(add ? 'market.addMcp' : 'market.importMcp', {
        choices: selected.map(({ id, name, agents, sourceId, another }) => ({
          id,
          name,
          agents,
          sourceId,
          another,
        })),
      })
      toast(t('mcp.addedChecking', { count: selected.length }))
      onDone()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="k-mcp-dialog-form">
      <SettingsDialogBody>
        {children}
        {picks.map((choice, i) => {
          const row = rows.find(({ id }) => id === choice.id)
          if (!row) return null
          const copies = picks.filter((other) => other.id === choice.id)
          return (
            <ReviewRow
              key={choice.id + ':' + choice.copy}
              row={row}
              choice={choice}
              add={add}
              change={(patch) => change(i, patch)}
              blockedSources={copies
                .filter((other) => other !== choice)
                .flatMap(({ sourceId }) => (sourceId ? [sourceId] : []))}
              addCopy={
                row.differentKeys.length > 0 && !choice.copy && copies.length === 1
                  ? () =>
                      setPicks((current) => [
                        ...current.slice(0, i + 1),
                        draft(row, false, true),
                        ...current.slice(i + 1),
                      ])
                  : undefined
              }
            />
          )
        })}
        {failed && (
          <p role="alert" className="kettu-sd__error">
            {t('mcp.importFailed')}
          </p>
        )}
        {!add && <p className="text-muted-foreground">{t('mcp.keepOriginal')}</p>}
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('mcp.notNow')}
        </DialogClose>
        <SetButton
          size="md"
          variant="primary"
          type="submit"
          disabled={!valid || busy}
          loading={busy}
        >
          {add ? t('mcp.addAndCheck') : t('mcp.importCount', { count: selected.length })}
        </SetButton>
      </SettingsDialogFooter>
    </form>
  )
}

export function McpImportDialog({
  discovery,
  target,
  close,
}: {
  discovery: McpDiscovery
  target: string
  close(): void
}) {
  const { t } = useTranslation('marketplace')
  const all = target === 'all'
  const rows = all ? discovery.servers : discovery.servers.filter(({ id }) => id === target)
  const kept = discovery.servers.filter(({ existing }) => existing.length > 0)
  return (
    <McpConfirmation
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
      title={t('mcp.importTitle')}
    >
      <ReviewChoices rows={rows} given={all ? undefined : target} add={false} onDone={close}>
        {kept.length > 0 && (
          <section className="k-mcp-existing">
            <strong>{t('mcp.alreadyKept')}</strong>
            {kept.map((row) => (
              <p key={row.id}>{row.name}</p>
            ))}
          </section>
        )}
        {all && <McpFileErrors errors={discovery.errors} />}
      </ReviewChoices>
    </McpConfirmation>
  )
}

function AddInput({ close, onAdded }: { close(): void; onAdded(): void }) {
  const { t } = useTranslation('marketplace')
  const { request } = useHostScope()
  const [text, setText] = useState('')
  const [result, setResult] = useState<{ text: string; rows: McpDiscoveryRow[] }>()
  const [error, setError] = useState('')
  useEffect(() => {
    if (!text.trim()) return
    let active = true
    const timer = setTimeout(() => {
      void request('market.previewMcp', { text }).then(
        (rows) => {
          if (active) setResult({ text, rows })
        },
        () => {
          if (active) setError(text)
        },
      )
    }, 200)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [request, text])
  const field = (
    <div className="k-mcp-paste">
      <label htmlFor="mcp-paste">{t('mcp.paste')}</label>
      <Textarea
        id="mcp-paste"
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t('mcp.pastePlaceholder')}
        spellCheck={false}
        className="font-mono"
      />
      {text && text === error && (
        <p role="alert" className="kettu-sd__error">
          {t('mcp.badInput')}
        </p>
      )}
    </div>
  )
  return (
    <>
      <SettingsDialogBody>{field}</SettingsDialogBody>
      {result?.text === text ? (
        <ReviewChoices key={result.rows[0]?.id} add rows={result.rows} onDone={onAdded} />
      ) : (
        <SettingsDialogFooter>
          <SetButton size="md" variant="ghost" onClick={close}>
            {t('mcp.notNow')}
          </SetButton>
          <SetButton size="md" variant="primary" disabled>
            {t('mcp.addAndCheck')}
          </SetButton>
        </SettingsDialogFooter>
      )}
    </>
  )
}

export function McpAddDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  onAdded(): void
}) {
  const { t } = useTranslation('marketplace')
  return (
    <McpConfirmation open={open} onOpenChange={onOpenChange} title={t('mcp.addTitle')}>
      <AddInput
        close={() => onOpenChange(false)}
        onAdded={() => {
          onOpenChange(false)
          onAdded()
        }}
      />
    </McpConfirmation>
  )
}
