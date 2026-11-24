import { useRef, useState } from 'react'
import { ComputerTerminal01Icon, PlusSignIcon } from '@hugeicons/core-free-icons'
import { useDefaultLayout } from 'react-resizable-panels'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable'
import { PaneBody, PaneEmpty, PaneIcon } from '@renderer/features/shell/panel-button'
import { SHEET_INSIDE_RADIUS } from '@renderer/features/shell/sheet'
import { layoutStorage } from '@renderer/lib/storage'
import {
  createTerminal,
  focusTerminalSide,
  terminalsOf,
  useTerminalsStore,
  type TerminalSide,
  type TerminalState,
} from '@renderer/stores/terminals'
import { OwnerBar, PasswordStrip, TerminalControl } from './terminal-owner'
import { TerminalView } from './terminal-view'

// The two sides of a split panel; alone, the left one fills it.
const LEFT = 'terminal-left'
const RIGHT = 'terminal-right'

/**
 * What a terminal's tab shows in the side panel: the session's selected terminal, or New
 * session's, and the one beside it while split. They open in `projectPath`, the session's folder.
 */
export function TerminalPanel({ projectPath, panel }: { projectPath: string; panel: string }) {
  const { t } = useTranslation(['terminal', 'common'])
  const list = useTerminalsStore(useShallow((s) => terminalsOf(s.byId, panel, s.order[panel])))
  const activeId = useTerminalsStore((s) => s.active[panel])
  const rightId = useTerminalsStore((s) => s.split[panel] ?? null)
  const side = useTerminalsStore((s) => s.focusedSide[panel] ?? 'left')
  const error = useTerminalsStore((s) => s.errors[panel] ?? null)
  const [creating, setCreating] = useState(false)
  const right = list.find((t) => t.id === rightId) ?? null
  const active =
    list.find((t) => t.id === activeId) ?? list.filter((t) => t.id !== right?.id).at(-1)
  const split = !!active && !!right
  const layout = useDefaultLayout({
    id: 'terminal-split',
    panelIds: split ? [LEFT, RIGHT] : [LEFT],
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true,
  })

  const starting = async (start: () => Promise<unknown>) => {
    setCreating(true)
    await start()
    setCreating(false)
  }
  const newTerminal = () => void starting(() => createTerminal(projectPath, panel))

  return (
    <PaneBody data-terminal-panel="">
      {error && (
        <p role="alert" className="kp-alert">
          {error}
        </p>
      )}
      <div className="kp-body">
        {active ? (
          <ResizablePanelGroup
            orientation="horizontal"
            defaultLayout={layout.defaultLayout}
            onLayoutChanged={layout.onLayoutChanged}
            className="min-h-0 flex-1"
          >
            <ResizablePanel id={LEFT} minSize="160px" className="min-w-0">
              <TerminalSideView
                panel={panel}
                terminal={active}
                side={split ? 'left' : null}
                focused={!split || side === 'left'}
              />
            </ResizablePanel>
            {split && (
              <>
                <ResizableHandle className="kp-split-handle" />
                <ResizablePanel id={RIGHT} defaultSize="50%" minSize="160px" className="min-w-0">
                  <TerminalSideView
                    panel={panel}
                    terminal={right}
                    side="right"
                    focused={side === 'right'}
                  />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        ) : (
          !creating && (
            <PaneEmpty
              icon={<PaneIcon icon={ComputerTerminal01Icon} size={20} />}
              title={t('panel.empty')}
            >
              <button type="button" className="kp-btn" onClick={newTerminal}>
                <PaneIcon icon={PlusSignIcon} size={13} />
                {t('panel.newTerminal')}
              </button>
            </PaneEmpty>
          )
        )}
      </div>
    </PaneBody>
  )
}

/**
 * One terminal shown in the pane, under the strip of the agent that started it and over its notice
 * that typing takes it over. While split, a press or focus in it makes its side the focused one.
 */
function TerminalSideView({
  panel,
  terminal,
  side,
  focused,
}: {
  panel: string
  terminal: TerminalState
  side: TerminalSide | null
  focused: boolean
}) {
  const focus = side ? () => focusTerminalSide(panel, side) : undefined
  const box = useRef<HTMLDivElement>(null)
  const strip = terminal.waiting === 'password' && !terminal.stale
  // The box reaches the sheet's lower corners on its outer sides, unless the strip lies under it.
  const lower = (outer: boolean) => (outer && !strip ? SHEET_INSIDE_RADIUS : '0')
  const radius = `0 0 ${lower(side !== 'left')} ${lower(side !== 'right')}`
  return (
    <div
      className="kp-tview"
      data-split={side ? '' : undefined}
      data-focused={focused || undefined}
      onPointerDownCapture={focus}
      onFocusCapture={focus}
    >
      {terminal.owner && <OwnerBar terminal={terminal} owner={terminal.owner} />}
      <div ref={box} className="kp-tbox">
        <TerminalView key={terminal.id} terminal={terminal} focused={focused} />
        {terminal.owner && (
          <TerminalControl terminal={terminal} owner={terminal.owner} box={box} radius={radius} />
        )}
      </div>
      {strip && <PasswordStrip terminal={terminal} />}
    </div>
  )
}
