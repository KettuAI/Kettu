// A library server's tools that changed since the user accepted them: the tag on its row, the
// line on its Tools tab and the window that shows each change and accepts the ones checked.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MarketServer } from '@shared/marketplace'
import {
  changedCount,
  type McpToolChanges,
  type McpToolDefinition,
  type McpToolDiff,
} from '@shared/mcp-insight'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Dialog } from '@renderer/components/ui/dialog'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { SetButton } from '@renderer/features/settings/controls'
import {
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
} from '@renderer/features/settings/settings-dialog'
import { Diff } from '@renderer/features/session/markdown'
import { monthDay } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import './mcp-tool-changes.css'

/** After a server's name: how many of its tools changed, and whether they are held back. */
export function McpToolChangesTag({ changes }: { changes: McpToolChanges }) {
  const { t } = useTranslation('marketplace')
  const count = changedCount(changes)
  return (
    <span className="k-mcp-held-tag">
      {t(changes.guard === 'hold' ? 'mcp.heldTag' : 'mcp.changedTag', { count })}
    </span>
  )
}

/** The Tools tab's line about the changes, with the button that opens them. */
export function McpToolChangesBanner({
  changes,
  review,
}: {
  changes: McpToolChanges
  review(): void
}) {
  const { t } = useTranslation('marketplace')
  const count = changedCount(changes)
  const key =
    changes.guard === 'hold'
      ? 'mcp.page.heldBanner'
      : changes.guard === 'note'
        ? 'mcp.page.noteBanner'
        : 'mcp.page.byAgentBanner'
  return (
    <div className="k-mcp-held" role="status">
      <span>{t(key, { count, date: monthDay(changes.since) })}</span>
      <SetButton size="sm" variant="secondary" onClick={review}>
        {t('mcp.page.reviewChanges')}
      </SetButton>
    </div>
  )
}

export function McpToolChangesDialog({
  server,
  changes,
  open,
  onOpenChange,
}: {
  server: Pick<MarketServer, 'id' | 'title'>
  changes: McpToolChanges | null
  open: boolean
  onOpenChange(open: boolean): void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent className="sm:max-w-180">
        {open && (
          <ChangesForm server={server} changes={changes} onDone={() => onOpenChange(false)} />
        )}
      </SettingsDialogContent>
    </Dialog>
  )
}

function ChangesForm({
  server,
  changes,
  onDone,
}: {
  server: Pick<MarketServer, 'id' | 'title'>
  changes: McpToolChanges | null
  onDone(): void
}) {
  const { t } = useTranslation('marketplace')
  const { request } = useHostScope()
  const [diffs, setDiffs] = useState<McpToolDiff[] | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revision = JSON.stringify(changes)
  useEffect(() => {
    let live = true
    request('market.mcpToolDiff', { serverId: server.id })
      .then((found) => {
        if (!live) return
        setDiffs(found)
        setChecked(new Set(found.filter((d) => d.kind !== 'removed').map((d) => d.name)))
      })
      .catch((e: unknown) => live && setReadError(errorMessage(e)))
    return () => {
      live = false
    }
  }, [request, server.id, revision])
  const waiting = (diffs ?? []).filter((d) => d.kind !== 'removed')
  const removed = (diffs ?? []).filter((d) => d.kind === 'removed')
  const accept = async () => {
    setBusy(true)
    setError(null)
    try {
      await request('market.acceptMcpTools', { serverId: server.id, names: [...checked] })
      onDone()
    } catch (e) {
      setError(t('mcp.changes.failed', { error: errorMessage(e) }))
    } finally {
      setBusy(false)
    }
  }
  const toggle = (name: string, on: boolean) =>
    setChecked((current) => {
      const next = new Set(current)
      if (on) next.add(name)
      else next.delete(name)
      return next
    })
  const hold = changes?.guard !== 'note'
  return (
    <>
      <SettingsDialogHeader title={t('mcp.changes.title', { name: server.title })}>
        {t(hold ? 'mcp.changes.descriptionHold' : 'mcp.changes.descriptionNote')}
      </SettingsDialogHeader>
      <SettingsDialogBody className="k-mcp-changes">
        {readError ? (
          <p className="k-mcp-warning">{t('mcp.changes.readFailed', { error: readError })}</p>
        ) : !diffs ? (
          <div aria-label={t('mcp.changes.loading')} className="k-mcp-changes__loading">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : waiting.length === 0 ? (
          <p className="k-mcp-muted">{t('mcp.changes.none')}</p>
        ) : (
          <ul className="k-mcp-changes__list">
            {waiting.map((diff) => (
              <ToolChange
                key={diff.name}
                diff={diff}
                checked={checked.has(diff.name)}
                onChecked={(on) => toggle(diff.name, on)}
              />
            ))}
            {removed.map((diff) => (
              <ToolChange key={diff.name} diff={diff} />
            ))}
          </ul>
        )}
        {error && (
          <p className="k-mcp-warning" role="alert">
            {error}
          </p>
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <SetButton size="md" variant="ghost" onClick={onDone}>
          {t('mcp.changes.keepAll')}
        </SetButton>
        <SetButton
          size="md"
          variant="primary"
          loading={busy}
          disabled={checked.size === 0 || busy}
          onClick={() => void accept()}
        >
          {t('mcp.changes.accept', { count: checked.size })}
        </SetButton>
      </SettingsDialogFooter>
    </>
  )
}

function ToolChange({
  diff,
  checked,
  onChecked,
}: {
  diff: McpToolDiff
  checked?: boolean
  onChecked?(on: boolean): void
}) {
  const { t } = useTranslation('marketplace')
  const before = diff.before
  const after = diff.after
  const describe = (tool: McpToolDefinition | null) => (tool ? (tool.description ?? '') : null)
  const params = (tool: McpToolDefinition | null) =>
    tool ? JSON.stringify(tool.inputSchema ?? {}, null, 2) + '\n' : null
  const descriptionChanged = describe(before) !== describe(after)
  const paramsChanged = params(before) !== params(after)
  return (
    <li className="k-mcp-change" data-kind={diff.kind}>
      <div className="k-mcp-change__head">
        {onChecked ? (
          <label>
            <Checkbox
              checked={checked}
              aria-label={t('mcp.changes.select', { name: diff.name })}
              onCheckedChange={(on) => onChecked(on === true)}
            />
            <code className="k-mkt-mono">{diff.name}</code>
          </label>
        ) : (
          <code className="k-mkt-mono">{diff.name}</code>
        )}
        <span className="k-mcp-tag" data-tag={diff.kind}>
          {t(`mcp.changes.kind.${diff.kind}`)}
        </span>
      </div>
      {diff.kind === 'removed' ? (
        <p className="k-mcp-muted">{t('mcp.changes.removedNote')}</p>
      ) : (
        <>
          {(descriptionChanged || diff.kind === 'added') && (
            <section>
              <h3>{t('mcp.changes.description')}</h3>
              {(describe(after) ?? '') === '' && diff.kind === 'added' ? (
                <p className="k-mcp-muted">{t('mcp.changes.noDescription')}</p>
              ) : (
                <Diff
                  path="description.md"
                  oldText={before ? withEnd(describe(before) ?? '') : null}
                  newText={withEnd(describe(after) ?? '')}
                />
              )}
            </section>
          )}
          {(paramsChanged || diff.kind === 'added') && (
            <section>
              <h3>{t('mcp.changes.parameters')}</h3>
              <Diff path="parameters.json" oldText={params(before)} newText={params(after) ?? ''} />
            </section>
          )}
        </>
      )}
    </li>
  )
}

function withEnd(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}
