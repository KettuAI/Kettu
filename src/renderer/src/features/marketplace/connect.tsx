// Connecting a remote server that signs in with OAuth: the Connect button and its popover, which
// picks the agents, then waits while the user signs in at the service; and the connection's state
// with what can be done about it.

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  Delete02Icon,
  Link04Icon,
  MoreHorizontalIcon,
  RefreshIcon,
  Tick02Icon,
  Unlink04Icon,
  UserMultiple02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { CatalogServer, MarketConnection, MarketServer } from '@shared/marketplace'
import { Dropdown, Icon, Popover } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { SettingSwitch } from '@renderer/features/settings/controls'
import { useHostScope } from '@renderer/stores/host-scope'
import {
  cancelConnect,
  connectServer,
  connectsHere,
  disconnectServer,
  dismissConnect,
  openPage,
  setServerOn,
  type AgentChoice,
} from './actions'
import { AgentsDialog, UninstallDialog } from './dialogs'
import { useConnectFlow, useConnection } from './hooks'
import { AgentPicker } from './install'
import { oauthFlow } from './model'

/** Copies `text`; the button says so for a moment. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useTranslation('marketplace')
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? t('connect.copied') : label}
    </Button>
  )
}

/**
 * The Connect popover: the agents to give the server to, when it is not kept yet, then the wait
 * for the sign-in, a browser page or a code to enter, then why it failed with Retry. It closes
 * once the Connect it started ends connected or is cancelled.
 */
function ConnectPanel({
  server,
  kept,
  onClose,
}: {
  server: CatalogServer | MarketServer
  kept: MarketServer | null
  onClose: () => void
}) {
  const { t } = useTranslation(['marketplace', 'common'])
  const scope = useHostScope()
  const flow = useConnectFlow(server.id)
  const [agents, setAgents] = useState<AgentChoice>(kept?.agents ?? 'all')
  // Whether this popover has seen a Connect, so that its end closes it.
  const [seen, setSeen] = useState(flow !== null)
  useEffect(() => {
    if (seen && !flow) onClose()
  }, [seen, flow, onClose])

  const name = server.title
  const device = oauthFlow(server.spec) === 'device'
  const here = connectsHere(scope, server.spec)
  const start = () => {
    setSeen(true)
    void connectServer(scope, server, kept?.agents ?? agents)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    start()
  }
  const cancel = () => void cancelConnect(scope, server.id, name)

  if (flow?.phase === 'waiting' && flow.start?.kind === 'browser') {
    const url = flow.start.url
    return (
      <div className="k-mkt-connect" role="status">
        <b>{t('connect.title', { name })}</b>
        <span className="k-mkt-connect__wait">
          <span className="ui-as-spinner" aria-hidden />
          {t('connect.browserWaiting')}
        </span>
        <small>{t('connect.browserHint')}</small>
        <div className="k-mkt-connect__actions">
          <CopyButton text={url} label={t('connect.copyLink')} />
          <Button size="sm" variant="ghost" onClick={cancel}>
            {t('common:actions.cancel')}
          </Button>
        </div>
      </div>
    )
  }
  if (flow?.phase === 'waiting' && flow.start?.kind === 'device') {
    const { userCode, verificationUri } = flow.start
    return (
      <div className="k-mkt-connect" role="status">
        <b>{t('connect.deviceTitle', { service: name })}</b>
        <code className="k-mkt-connect__code" data-selectable="">
          {userCode}
        </code>
        <div className="k-mkt-connect__actions">
          <CopyButton text={userCode} label={t('connect.copyCode')} />
          <Button
            size="sm"
            icon={<Icon icon={Link04Icon} size={14} />}
            onClick={() => openPage(verificationUri)}
          >
            {t('connect.openService', { service: name })}
          </Button>
        </div>
        <span className="k-mkt-connect__wait">
          <span className="ui-as-spinner" aria-hidden />
          {t('connect.deviceWaiting', { service: name })}
        </span>
        <div className="k-mkt-connect__actions">
          <Button size="sm" variant="ghost" onClick={cancel}>
            {t('common:actions.cancel')}
          </Button>
        </div>
      </div>
    )
  }
  if (flow?.phase === 'failed') {
    return (
      <div className="k-mkt-connect" role="alert">
        <b>{t('connect.title', { name })}</b>
        <span className="k-mkt-connect__error" data-selectable="">
          {t('connect.failed', { error: flow.error })}
        </span>
        <div className="k-mkt-connect__actions">
          {here && (
            <Button size="sm" icon={<Icon icon={RefreshIcon} size={14} />} onClick={start}>
              {t('common:actions.retry')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common:actions.close')}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <form className="k-mkt-install" onSubmit={submit}>
      <b>{t('connect.title', { name })}</b>
      <span>
        {!here
          ? t('connect.browserOnHost')
          : device
            ? t('connect.deviceNote', { service: name })
            : t('connect.browserNote', { service: name })}
      </span>
      {!kept && here && (
        <div className="k-mkt-install__field">
          <small>{t('install.useIn')}</small>
          <AgentPicker value={agents} onChange={setAgents} label={t('install.useIn')} />
        </div>
      )}
      <Button
        size="sm"
        type="submit"
        disabled={!here}
        // A server that needs no sign-in is connected as soon as the host's event arrives.
        loading={flow?.phase === 'starting' || flow?.start?.kind === 'open'}
      >
        {t('connect.submit')}
      </Button>
    </form>
  )
}

/** The popover around a trigger, which forgets a failed Connect once it closes. */
function ConnectPopover({
  server,
  kept,
  open,
  setOpen,
  children,
}: {
  server: CatalogServer | MarketServer
  kept: MarketServer | null
  open: boolean
  setOpen: (open: boolean) => void
  children: ReactNode
}) {
  const scope = useHostScope()
  const close = () => {
    setOpen(false)
    dismissConnect(scope, server.id)
  }
  return (
    <span className="ui-as-anchor">
      {children}
      <Popover open={open} onClose={close} align="end" className="ui-as-menu k-mkt-install-pop">
        <ConnectPanel server={server} kept={kept} onClose={close} />
      </Popover>
    </span>
  )
}

/** Connect for a server not kept yet: in a row, or as the listing's main button. */
export function ConnectButton({ server, big = false }: { server: CatalogServer; big?: boolean }) {
  const { t } = useTranslation('marketplace')
  const [open, setOpen] = useState(false)
  const flow = useConnectFlow(server.id)
  const busy = flow !== null && flow.phase !== 'failed'
  return (
    <ConnectPopover server={server} kept={null} open={open} setOpen={setOpen}>
      <Button
        size={big ? 'md' : 'sm'}
        variant={big ? 'primary' : 'secondary'}
        aria-label={t('row.action', { action: t('row.connect'), name: server.title })}
        aria-expanded={open}
        icon={busy ? <span className="ui-as-spinner" aria-hidden /> : undefined}
        onClick={() => setOpen(!open)}
      >
        {busy ? t('row.connecting') : t('row.connect')}
      </Button>
    </ConnectPopover>
  )
}

/** A kept server's connection, in words and the tone of its state. */
export function ConnectionLabel({ connection }: { connection: MarketConnection | null }) {
  const { t } = useTranslation('marketplace')
  if (!connection) return null
  switch (connection.state) {
    case 'connected':
      return (
        <span className="k-mkt-conn" data-state="connected">
          <Icon icon={Tick02Icon} size={13} />
          {connection.account
            ? t('connection.connectedAs', { account: connection.account })
            : t('connection.connected')}
        </span>
      )
    case 'needs-reconnect':
      return (
        <span className="k-mkt-conn" data-state="attention" title={connection.reason}>
          {t('connection.needsReconnect')}
        </span>
      )
    case 'error':
      return (
        <span className="k-mkt-conn" data-state="error" title={connection.message}>
          {t('connection.error', { message: connection.message })}
        </span>
      )
    case 'disconnected':
      return (
        <span className="k-mkt-conn" data-state="off">
          {t('connection.disconnected')}
        </span>
      )
  }
}

/**
 * A kept OAuth server's controls: its state, Connect or Reconnect when it is not connected, its
 * switch, and a menu with Reconnect, Disconnect, Choose agents and Remove. `compact` leaves out
 * the state, which a row's line already says.
 */
export function ConnectionControls({
  server,
  compact = false,
  onRemoved,
}: {
  server: MarketServer
  compact?: boolean
  onRemoved?: () => void
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const connection = useConnection(server.id)
  const flow = useConnectFlow(server.id)
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState<'agents' | 'remove' | null>(null)
  const busy = flow !== null && flow.phase !== 'failed'
  const connected = connection?.state === 'connected'
  const reconnect = () => {
    void connectServer(scope, server, server.agents)
    setOpen(true)
  }
  const close = (next: boolean) => {
    if (!next) setDialog(null)
  }
  return (
    <span className="k-mkt-row-end">
      {!compact && <ConnectionLabel connection={connection} />}
      <ConnectPopover server={server} kept={server} open={open} setOpen={setOpen}>
        {(busy || (connection && !connected)) && (
          <Button
            size="sm"
            variant="secondary"
            className={connection?.state === 'needs-reconnect' ? 'k-mkt-attention' : undefined}
            icon={busy ? <span className="ui-as-spinner" aria-hidden /> : undefined}
            aria-expanded={open}
            onClick={() => (busy ? setOpen(!open) : reconnect())}
          >
            {busy
              ? t('row.connecting')
              : connection?.state === 'disconnected'
                ? t('connection.connect')
                : t('connection.reconnect')}
          </Button>
        )}
      </ConnectPopover>
      <SettingSwitch
        label={t('listing.switch', { name: server.title })}
        checked={server.on}
        onChange={(on) => void setServerOn(scope, server.id, on)}
      />
      <Dropdown
        align="end"
        items={[
          {
            label: t('connection.reconnect'),
            icon: RefreshIcon,
            disabled: busy,
            onSelect: reconnect,
          },
          ...(connected
            ? [
                {
                  label: t('connection.disconnect'),
                  icon: Unlink04Icon,
                  onSelect: () => void disconnectServer(scope, server),
                },
              ]
            : []),
          {
            label: t('listing.chooseAgents'),
            icon: UserMultiple02Icon,
            onSelect: () => setDialog('agents'),
          },
          {
            label: t('connection.remove'),
            icon: Delete02Icon,
            danger: true,
            divider: true,
            onSelect: () => setDialog('remove'),
          },
        ]}
        trigger={({ open: menuOpen, toggle }) => (
          <button
            type="button"
            className="k-mkt-icon-btn"
            aria-label={t('listing.more', { name: server.title })}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={toggle}
          >
            <Icon icon={MoreHorizontalIcon} size={16} />
          </button>
        )}
      />
      <AgentsDialog server={server} open={dialog === 'agents'} onOpenChange={close} />
      <UninstallDialog
        server={server}
        oauth
        open={dialog === 'remove'}
        onOpenChange={close}
        onUninstalled={() => onRemoved?.()}
      />
    </span>
  )
}
