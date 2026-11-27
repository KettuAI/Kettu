import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { formatMcpCommand, splitCommand } from '@shared/mcp-command'
import { specInputs, type MarketServer, type McpSpec } from '@shared/marketplace'
import { Button } from '@renderer/components/affect/button'
import { TextField } from '@renderer/components/affect/text-field'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { useHostScope } from '@renderer/stores/host-scope'
import { changeServer, disconnectServer } from './actions'
import { KeysDialog, UninstallDialog } from './dialogs'
import {
  useAgentName,
  useConnection,
  useMcpInsight,
  useMcpState,
  useMcpToolChanges,
  useTransportName,
} from './hooks'
import { McpCheckButton, McpSignIn, McpState } from './mcp-library'
import { homeShort, type Listing } from './model'
import { ExternalLink } from './parts'
import { RunSettings } from './run-settings'
import { McpCallsTab, McpLogsTab, McpRunning, McpToolsTab, McpWhoGets } from './mcp-server-tabs'

export function McpServerPageBody({
  server,
  listing,
  back,
}: {
  server: MarketServer
  listing: Listing
  back(): void
}) {
  const { t } = useTranslation('marketplace')
  const check = useMcpState(server)
  const transport = useTransportName(server.spec)
  const agentName = useAgentName()
  const insight = useMcpInsight(server)
  const held = useMcpToolChanges(server.id)?.guard === 'hold'
  const toolCount = insight?.tools?.length ?? (check?.state === 'connected' ? check.tools : null)
  const tabs = [
    'overview',
    'tools',
    'calls',
    ...(server.spec.type === 'stdio' ? (['logs'] as const) : []),
    'settings',
  ] as const
  return (
    <>
      {check?.state === 'error' && (
        <div className="k-mcp-error" role="alert">
          <div>
            <McpState server={server} check={check} />
            <p>{t(`mcp.fix.${check.reason}`)}</p>
          </div>
          <McpCheckButton server={server} again />
        </div>
      )}
      <Tabs defaultValue="overview">
        <TabsList variant="line" aria-label={t('mcp.serverTabs')}>
          {tabs.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {t(`mcp.tabs.${tab}`)}
              {tab === 'tools' && toolCount !== null && <span>{toolCount}</span>}
              {tab === 'tools' && held && (
                <span
                  className="k-mcp-held-dot"
                  role="img"
                  aria-label={t('mcp.page.heldDot')}
                  title={t('mcp.page.heldDot')}
                />
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview" className="k-mcp-server-panel">
          <section className="k-mcp-server-card">
            <div className="k-mcp-section-head">
              <h2>{t('mcp.status')}</h2>
              {check?.state === 'needs-sign-in' && <McpSignIn server={server} />}
              <McpCheckButton server={server} pending={check?.state === 'checking'} />
            </div>
            <McpState server={server} check={check} />
            {check?.state === 'connected' && (
              <dl className="k-mcp-timings">
                <div>
                  <dt>{t('mcp.step.start')}</dt>
                  <dd>{t('mcp.elapsed', { ms: check.startMs })}</dd>
                </div>
                <div>
                  <dt>{t('mcp.step.initialize')}</dt>
                  <dd>{t('mcp.elapsed', { ms: check.initializeMs })}</dd>
                </div>
                <div>
                  <dt>{t('mcp.step.tools')}</dt>
                  <dd>{t('mcp.elapsed', { ms: check.toolsMs })}</dd>
                </div>
              </dl>
            )}
          </section>
          {server.spec.type === 'stdio' && <McpRunning server={server} />}
          <McpWhoGets server={server} insight={insight} />
          <section className="k-mcp-server-card">
            <h2>{t('mcp.about')}</h2>
            <dl>
              <dt>{t('listing.facts.source')}</dt>
              <dd>
                {server.importedFrom?.length ? (
                  <ul className="k-mcp-sources">
                    {server.importedFrom.map((source, i) => (
                      <li key={source.path + i}>
                        <span>
                          {source.agentId
                            ? agentName(source.agentId)
                            : (source.app ?? t('mcp.project'))}
                        </span>
                        <code className="k-mkt-mono">{homeShort(source.path)}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  t(
                    server.source === 'manual'
                      ? 'listing.manual'
                      : server.source === 'registry'
                        ? 'listing.registry'
                        : server.source === 'plugin'
                          ? 'plugin.from.source'
                          : 'page.title',
                  )
                )}
              </dd>
              <dt>{t('mcp.transport')}</dt>
              <dd>{transport}</dd>
              <dt>{t(server.spec.type === 'stdio' ? 'mcp.command' : 'mcp.address')}</dt>
              <dd className="k-mkt-mono">
                {server.spec.type === 'stdio'
                  ? formatMcpCommand(server.spec.command, server.spec.args)
                  : server.spec.url}
              </dd>
              {listing.version && (
                <>
                  <dt>{t('listing.facts.version')}</dt>
                  <dd>{listing.version}</dd>
                </>
              )}
              {listing.repository && (
                <>
                  <dt>{t('mcp.docs')}</dt>
                  <dd>
                    <ExternalLink href={listing.repository} />
                  </dd>
                </>
              )}
              {listing.website && listing.website !== listing.repository && (
                <>
                  <dt>{t('mcp.website')}</dt>
                  <dd>
                    <ExternalLink href={listing.website} />
                  </dd>
                </>
              )}
            </dl>
          </section>
        </TabsContent>
        <TabsContent value="tools" className="k-mcp-server-panel">
          <McpToolsTab server={server} insight={insight} />
        </TabsContent>
        <TabsContent value="calls" className="k-mcp-server-panel">
          <McpCallsTab server={server} />
        </TabsContent>
        {server.spec.type === 'stdio' && (
          <TabsContent value="logs" className="k-mcp-server-panel">
            <McpLogsTab server={server} />
          </TabsContent>
        )}
        <TabsContent value="settings" className="k-mcp-server-panel">
          <McpServerSettings key={JSON.stringify(server.spec)} server={server} back={back} />
        </TabsContent>
      </Tabs>
    </>
  )
}

function McpServerSettings({ server, back }: { server: MarketServer; back(): void }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const connection = useConnection(server.id)
  const keys = scope.useMarketplaceStore((s) => s.keys?.[server.id])
  const [keysOpen, setKeysOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const { spec } = server
  const initial = spec.type === 'stdio' ? formatMcpCommand(spec.command, spec.args) : spec.url
  const [text, setText] = useState(initial)
  const [busy, setBusy] = useState(false)
  let replacement: McpSpec | null = null
  if (spec.type === 'stdio') {
    const words = splitCommand(text)
    if (words?.[0]) replacement = { ...spec, command: words[0], args: words.slice(1) }
  } else replacement = spec
  const valid = replacement !== null
  const changed = text !== initial
  const values = spec.type === 'stdio' ? spec.env : spec.headers
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!valid || !replacement) return
    const next = replacement
    setBusy(true)
    try {
      await changeServer(scope, server.id, (current) => ({
        ...current,
        spec: next,
      }))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <form className="k-mcp-server-card" onSubmit={(event) => void submit(event)}>
        <TextField
          label={t(spec.type === 'stdio' ? 'mcp.command' : 'mcp.address')}
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          readOnly={spec.type === 'http'}
        />
        {spec.type === 'http' && (
          <>
            <div className="k-mcp-section-head">
              <span>{t('mcp.signIn')}</span>
              {connection?.state === 'connected' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void disconnectServer(scope, server)}
                >
                  {t('mcp.signOut')}
                </Button>
              ) : (
                <McpSignIn server={server} />
              )}
            </div>
          </>
        )}
        {values.length > 0 && (
          <div>
            <h2>{t(spec.type === 'stdio' ? 'mcp.environment' : 'mcp.headers')}</h2>
            <ul className="k-mcp-values">
              {values.map((value) => (
                <li key={value.name}>
                  <code className="k-mkt-mono">{value.name}</code>
                  {'input' in value ? (
                    <>
                      <span>
                        {t(
                          keys?.includes(value.name) ? 'listing.input.set' : 'listing.input.notSet',
                        )}
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => setKeysOpen(true)}>
                        {t('mcp.change')}
                      </Button>
                    </>
                  ) : (
                    <span>
                      <code>{value.value}</code>
                      {value.value.includes('${') && <> · {t('mcp.loginShell')}</>}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="k-mcp-settings-actions">
          <Button size="sm" type="submit" disabled={!valid || !changed || busy} loading={busy}>
            {t('mcp.save')}
          </Button>
        </div>
      </form>
      <RunSettings server={server} />
      <section className="k-mcp-server-card k-mcp-remove">
        <Button size="sm" variant="secondary" onClick={() => setRemoveOpen(true)}>
          {t('mcp.remove')}
        </Button>
      </section>
      {specInputs(spec).length > 0 && (
        <KeysDialog server={server} open={keysOpen} onOpenChange={setKeysOpen} />
      )}
      <UninstallDialog
        server={server}
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        onUninstalled={back}
      />
    </>
  )
}
