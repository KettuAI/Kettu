import { useEffect, useState } from 'react'
import {
  ArrowRight01Icon,
  Cancel01Icon,
  MoreHorizontalIcon,
  PlugSocketIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { McpCheck, McpDiscoveryRow } from '@shared/mcp-discovery'
import type { MarketServer, McpSpec } from '@shared/marketplace'
import { Dropdown, Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { SettingSwitch } from '@renderer/features/settings/controls'
import { useHostScope } from '@renderer/stores/host-scope'
import { openMarketplace } from '@renderer/stores/view'
import { changeServer, setServerOn } from './actions'
import { ConnectButton } from './connect'
import { onSignInRequest, signInRequested, takeSignInRequest } from './sign-in-request'
import {
  useAgentName,
  useChoosableAgents,
  useKeptServers,
  useMcpState,
  useMcpToolChanges,
  useTransportName,
} from './hooks'
import { keptItemKey, type Listing } from './model'
import { McpFileErrors, McpImportDialog } from './mcp-review'
import { TerminalGroup } from './mcp-terminal'
import { McpToolChangesDialog, McpToolChangesTag } from './mcp-tool-changes'
import { ItemRow, QuietNote, SkeletonRows } from './rows'
import { serverSubject } from './tile-art'

function hostname(spec: McpSpec): string {
  if (spec.type !== 'http') return ''
  return URL.parse(spec.url)?.hostname ?? ''
}

export function McpState({ server, check }: { server: MarketServer; check?: McpCheck }) {
  const { t } = useTranslation('marketplace')
  const state = check?.state ?? 'idle'
  const label =
    check?.state === 'error'
      ? t(`mcp.reason.${check.reason}`, {
          command: server.spec.type === 'stdio' ? server.spec.command : '',
          detail: check.detail ? ': ' + check.detail : '',
          name: check.detail,
          seconds: check.seconds,
          step: t(`mcp.step.${check.step ?? 'initialize'}`),
          status: check.status,
          host: hostname(server.spec),
        })
      : t(`mcp.state.${check?.state ?? 'idle'}`)
  return (
    <span
      className="k-mcp-state"
      data-state={state}
      role={state === 'checking' ? 'status' : undefined}
      title={label}
    >
      {state === 'checking' ? (
        <Spinner className="size-3" />
      ) : (
        <span aria-hidden className="k-mcp-state-dot" />
      )}
      <span>{label}</span>
    </span>
  )
}

export function McpCheckButton({
  server,
  again,
  pending,
}: {
  server: MarketServer
  again?: boolean
  pending?: boolean
}) {
  const { t } = useTranslation('marketplace')
  const { request } = useHostScope()
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={pending}
      onClick={() =>
        void request('market.checkMcp', { serverId: server.id }).catch(() =>
          toast(t('mcp.checkFailed'), undefined, { tone: 'warning' }),
        )
      }
    >
      {t(again ? 'mcp.checkAgain' : 'mcp.check')}
    </Button>
  )
}

export function McpSignIn({ server }: { server: MarketServer }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const [busy, setBusy] = useState(false)
  const remote = server.spec.type === 'http'
  const oauth = server.spec.type === 'http' && server.spec.oauth !== undefined
  const url = server.spec.type === 'http' ? server.spec.url : ''
  /** Finds how the server signs in and keeps it; false when Kettu cannot sign in to it. */
  const findOAuth = async (): Promise<boolean> => {
    try {
      const { oauth } = await scope.request('market.detectSignIn', { url, headers: [] })
      if (!oauth) {
        toast(t('mcp.agentSignIn'), undefined, { tone: 'warning' })
        return false
      }
      await changeServer(scope, server.id, (current) =>
        current.spec.type === 'http' ? { ...current, spec: { ...current.spec, oauth } } : current,
      )
      return true
    } catch {
      toast(t('mcp.signInFailed'), undefined, { tone: 'warning' })
      return false
    }
  }
  const detect = async () => {
    setBusy(true)
    await findOAuth()
    setBusy(false)
  }
  // A sign-in asked for elsewhere: once the server signs in with OAuth, Connect takes it on.
  useEffect(() => {
    if (!remote || oauth) return
    const run = () =>
      void findOAuth().then((found) => {
        if (!found) takeSignInRequest(scope.hostId, server.id)
      })
    if (signInRequested(scope.hostId, server.id)) run()
    return onSignInRequest(scope.hostId, server.id, run)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, oauth, scope.hostId, server.id])
  if (!remote) return null
  if (oauth) return <ConnectButton server={server} kept={server} label={t('mcp.signIn')} />
  return (
    <Button size="sm" variant="secondary" loading={busy} onClick={() => void detect()}>
      {t('mcp.signIn')}
    </Button>
  )
}

function LibraryRow({ server, listing }: { server: MarketServer; listing: Listing }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const check = useMcpState(server)
  const transport = useTransportName(server.spec)
  const allAgents = useChoosableAgents()
  const agentName = useAgentName()
  const agents = server.agents === 'all' ? allAgents.map(({ id }) => id) : server.agents
  const open = () => openMarketplace({ item: keptItemKey('mcp', server.id), tab: 'mcp' })
  const changes = useMcpToolChanges(server.id)
  const [reviewing, setReviewing] = useState(false)
  return (
    <>
      <ItemRow
        title={server.title}
        subject={serverSubject({ ...listing, spec: server.spec })}
        tag={changes ? <McpToolChangesTag changes={changes} /> : undefined}
        meta={
          <>
            <McpState server={server} check={check} />
            <span>{transport}</span>
            {check?.state === 'connected' && (
              <span>{t('mcp.toolCount', { count: check.tools })}</span>
            )}
          </>
        }
        line={null}
        onOpen={open}
        end={
          <>
            <span className="k-mcp-agent-marks">
              {agents.slice(0, 5).map((id) => (
                <span key={id} title={agentName(id)}>
                  <AgentMark agent={id} size={16} dot={null} />
                </span>
              ))}
              {agents.length > 5 && (
                <span title={agents.slice(5).map(agentName).join(', ')}>+{agents.length - 5}</span>
              )}
            </span>
            {check?.state === 'needs-sign-in' && <McpSignIn server={server} />}
            {check?.state === 'error' && <McpCheckButton server={server} />}
            {changes && (
              <Button size="sm" variant="secondary" onClick={() => setReviewing(true)}>
                {t('mcp.review')}
              </Button>
            )}
            <SettingSwitch
              label={t('listing.switch', { name: server.title })}
              checked={server.on}
              onChange={(on) => void setServerOn(scope, server.id, on)}
            />
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('mcp.openNamed', { name: server.title })}
              onClick={open}
            >
              <Icon icon={ArrowRight01Icon} size={16} />
            </Button>
          </>
        }
      />
      <McpToolChangesDialog
        server={server}
        changes={changes}
        open={reviewing}
        onOpenChange={setReviewing}
      />
    </>
  )
}

function FoundRow({ row, review }: { row: McpDiscoveryRow; review(): void }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const agentName = useAgentName()
  const transport = useTransportName(row.spec)
  const sources = [
    ...new Set(
      row.sources.map((s) => (s.agentId ? agentName(s.agentId) : (s.app ?? t('mcp.project')))),
    ),
  ]
  const different = row.differentKeys.length > 0
  const differentCount = row.sources.length
  const hasKeys = row.sources.some(({ keys }) => keys.length > 0)
  return (
    <ItemRow
      title={row.name}
      icon={
        <span className="k-mcp-found-icon">
          <Icon icon={PlugSocketIcon} size={19} />
        </span>
      }
      tag={row.isNew ? <span className="k-mcp-new-dot" aria-label={t('mcp.new')} /> : undefined}
      meta={
        <>
          <span>{transport}</span>
          <span>{sources.join(', ')}</span>
          {hasKeys && (
            <span className="k-mcp-warning">
              {different
                ? t('mcp.differentKeys', { count: differentCount })
                : t('mcp.hardcodedKeys')}
            </span>
          )}
        </>
      }
      line={null}
      end={
        <>
          <Button size="sm" variant="secondary" onClick={review}>
            {t(row.existing.length > 0 ? 'mcp.another' : 'mcp.import')}
          </Button>
          <Dropdown
            items={row.sources.map((source) => ({
              label: t('mcp.showSource', {
                name: source.agentId ? agentName(source.agentId) : (source.app ?? t('mcp.project')),
              }),
              onSelect: () => void scope.api.showItem(source.path),
            }))}
            trigger={({ open, toggle }) => (
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('mcp.sourceMenu')}
                aria-expanded={open}
                onClick={toggle}
              >
                <Icon icon={MoreHorizontalIcon} size={16} />
              </Button>
            )}
          />
        </>
      }
    />
  )
}

export function McpLibrary({ query, showSections }: { query: string; showSections: boolean }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const agentName = useAgentName()
  const discovery = scope.useMarketplaceStore((s) => s.discovery)
  const failure = scope.useMarketplaceStore((s) => s.discoveryError)
  const loading = scope.useMarketplaceStore((s) => s.discoveryLoading)
  const [target, setTarget] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const kept = useKeptServers(query)
  const all = discovery?.servers ?? []
  const needle = query.trim().toLocaleLowerCase()
  const matches = all.filter(
    (row) =>
      (row.existing.length === 0 ||
        (row.differentKeys.length > 0 && row.sources.some((source) => !source.imported))) &&
      (!needle || row.name.toLocaleLowerCase().includes(needle)),
  )
  const rows = expanded || needle ? matches : matches.slice(0, 3)
  const fresh = all.filter(({ isNew }) => isNew)
  const names = [
    ...new Set(
      fresh.flatMap(({ sources }) =>
        sources.map(({ agentId, app }) =>
          agentId ? agentName(agentId) : (app ?? t('mcp.project')),
        ),
      ),
    ),
  ]
  return (
    <>
      {discovery?.notice && fresh.length > 0 && (
        <div className="k-mcp-notice" role="status">
          <span>{t('mcp.discoveryNotice', { count: fresh.length, names: names.join(', ') })}</span>
          <Button size="sm" variant="secondary" onClick={() => setTarget('all')}>
            {t('mcp.reviewImport')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('mcp.dismiss')}
            onClick={() => {
              const id = discovery.notice
              if (id) void scope.request('market.dismissMcpNotice', { id }).catch(() => {})
            }}
          >
            <Icon icon={Cancel01Icon} size={15} />
          </Button>
        </div>
      )}
      {showSections && (
        <>
          <section className="ui-as-int-section k-mcp-section">
            <h2 className="ui-as-int-section__title">{t('mcp.yourServers')}</h2>
            {kept.length === 0 && <p className="k-mkt-section-note">{t('installed.noServers')}</p>}
            <div className="k-mcp-rows">
              {kept.map(({ server, listing }) => (
                <LibraryRow key={server.id} server={server} listing={listing} />
              ))}
            </div>
          </section>
          <section className="ui-as-int-section k-mcp-section" aria-busy={loading}>
            <div className="k-mcp-section-head">
              <h2 className="ui-as-int-section__title">
                {t('mcp.found')} <span className="text-muted-foreground">{matches.length}</span>
              </h2>
              <Button
                size="sm"
                variant="secondary"
                disabled={!discovery || (!matches.length && !discovery.errors.length)}
                onClick={() => setTarget('all')}
              >
                {t('mcp.importMore')}
              </Button>
            </div>
            <p className="k-mkt-section-note">{t('mcp.foundNote')}</p>
            {failure && (
              <QuietNote
                action={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void scope.useMarketplaceStore.getState().loadDiscovery()}
                  >
                    {t('mcp.retry')}
                  </Button>
                }
              >
                {t('mcp.discoveryFailed')}
              </QuietNote>
            )}
            {!discovery && loading && <SkeletonRows rows={3} />}
            {discovery && matches.length === 0 && discovery.errors.length === 0 && (
              <p className="k-mkt-section-note">{t('mcp.noneFound')}</p>
            )}
            <div className="k-mcp-rows">
              {rows.map((row) => (
                <FoundRow key={row.id} row={row} review={() => setTarget(row.id)} />
              ))}
            </div>
            {matches.length > 3 && !needle && (
              <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}>
                {t(expanded ? 'mcp.showLess' : 'mcp.showAll', { count: matches.length })}
              </Button>
            )}
            {discovery && <McpFileErrors errors={discovery.errors} />}
          </section>
          <TerminalGroup />
        </>
      )}
      {target && discovery && (
        <McpImportDialog discovery={discovery} target={target} close={() => setTarget(null)} />
      )}
    </>
  )
}
