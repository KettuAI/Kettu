// A plugin's view drawn with Kettu's own parts, in the desktop app and in the web client alike.
// The plugin's script only gives data, which the host checks; nothing here runs plugin code, and
// a view that fails shows its own error without touching the window around it.

import { useState } from 'react'
import { Alert02Icon, ArrowLeft01Icon, ArrowReloadHorizontalIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { PluginViewAction, PluginViewContent, PluginViewParams } from '@shared/plugin-views'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Glyph } from '@renderer/features/shell/glyph'
import type { HostRequest } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { ActionsBody } from './actions-body'
import { DetailBody } from './detail-body'
import { FormBody } from './form-body'
import { ListBody } from './list-body'
import {
  usePluginView,
  type ActionExtra,
  type ActionHandle,
  type ViewState,
} from './use-plugin-view'
import './plugin-views.css'

export interface PluginViewProps {
  /** Asks the host the plugin is installed on. */
  request: HostRequest
  pluginId: string
  /** The view to open first; an action that opens another goes forward from it, and Back returns. */
  viewId: string
  params?: PluginViewParams
  /** Draws the context bar of a pane: what the view shows, Back and Refresh. On by default. */
  bar?: boolean
  className?: string
}

/** Opens one view of a plugin; another plugin, view or parameters start it over. */
export function PluginView(props: PluginViewProps) {
  const params = props.params ?? {}
  const key = `${props.pluginId}/${props.viewId}/${JSON.stringify(params)}`
  return <OpenView key={key} {...props} params={params} />
}

function OpenView({
  request,
  pluginId,
  viewId,
  params,
  bar = true,
  className,
}: PluginViewProps & { params: PluginViewParams }) {
  const { t } = useTranslation(['plugin-views', 'common'])
  const view = usePluginView(request, pluginId, { view: viewId, params })
  const [confirming, setConfirming] = useState<{ action: PluginViewAction; extra: ActionExtra }>()
  const [asking, setAsking] = useState(false)
  const { execute } = view
  const handle: ActionHandle = {
    busy: view.busy,
    run: (action, extra = {}) => {
      if (action.open) {
        view.open({ view: action.open.view, params: action.open.params ?? {} })
      } else if (action.destructive) {
        setConfirming({ action, extra })
        setAsking(true)
      } else {
        void execute(action, extra)
      }
    },
  }
  const { state } = view
  return (
    <div className={cn('kpv', className)} data-state={state.status}>
      {bar && (
        <div className="kpv-bar" data-back={view.depth > 1 || undefined}>
          {view.depth > 1 && (
            <Button
              variant="quiet"
              size="icon-sm"
              aria-label={t('back')}
              title={t('back')}
              onClick={view.back}
            >
              <Glyph icon={ArrowLeft01Icon} size={15} />
            </Button>
          )}
          <div className="kpv-scope">
            {state.status === 'ready' &&
              state.view.scope?.map((part, i) => <span key={i}>{part}</span>)}
          </div>
          <Button
            variant="quiet"
            size="icon-sm"
            className="kpv-refresh"
            data-busy={view.refreshing || undefined}
            aria-label={t('refresh')}
            title={t('refresh')}
            disabled={view.refreshing || state.status === 'loading'}
            onClick={view.reload}
          >
            <Glyph icon={ArrowReloadHorizontalIcon} size={15} />
          </Button>
        </div>
      )}
      <div className="kpv-scroll">
        <Content
          state={state}
          handle={handle}
          reload={view.reload}
          back={view.depth > 1 ? view.back : undefined}
        />
      </div>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('confirm.title', { label: confirming?.action.label ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.action.confirm ?? t('confirm.default')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => confirming && void execute(confirming.action, confirming.extra)}
            >
              {confirming?.action.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function Content({
  state,
  handle,
  reload,
  back,
}: {
  state: ViewState
  handle: ActionHandle
  reload: () => void
  back: (() => void) | undefined
}) {
  const { t } = useTranslation('plugin-views')
  if (state.status === 'loading') return <Loading />
  if (state.status === 'error') {
    const { code, detail } = state.error
    return (
      <Empty className="kpv-state" role="alert">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Glyph icon={Alert02Icon} size={20} />
          </EmptyMedia>
          <EmptyTitle>{t(`error.${code}`)}</EmptyTitle>
          {detail && (
            <EmptyDescription className="font-mono text-xs break-words" data-selectable="">
              {detail}
            </EmptyDescription>
          )}
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          {back && (
            <Button variant="outline" size="sm" onClick={back}>
              {t('back')}
            </Button>
          )}
          {code !== 'not_found' && (
            <Button variant="outline" size="sm" onClick={reload}>
              {t('retry')}
            </Button>
          )}
        </EmptyContent>
      </Empty>
    )
  }
  return <Body view={state.view} revision={state.revision} handle={handle} />
}

function Body({
  view,
  revision,
  handle,
}: {
  view: PluginViewContent
  revision: number
  handle: ActionHandle
}) {
  const { t } = useTranslation('plugin-views')
  switch (view.kind) {
    case 'list':
      return <ListBody view={view} handle={handle} />
    case 'detail':
      return <DetailBody view={view} handle={handle} />
    case 'form':
      return <FormBody key={revision} view={view} handle={handle} />
    case 'actions':
      return <ActionsBody view={view} handle={handle} />
    default:
      // A host newer than this window may have a kind it does not draw.
      return (
        <Empty className="kpv-state">
          <EmptyHeader>
            <EmptyDescription>{t('newerKettu')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )
  }
}

function Loading() {
  const { t } = useTranslation('common')
  return (
    <div className="kpv-skel" role="status" aria-label={t('loading')}>
      {[0, 1, 2].map((row) => (
        <div key={row}>
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-3.5 w-3/4" />
        </div>
      ))}
    </div>
  )
}
