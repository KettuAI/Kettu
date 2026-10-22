import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import {
  closeSession,
  createSession,
  deleteSession,
  descendantCount,
  renameSession,
} from '@renderer/app/actions'
import { AgentMark } from '@renderer/components/agents/agent-mark'
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Input } from '@renderer/components/ui/input'
import { errorMessage } from '@renderer/lib/host'
import { isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { sessionTitle } from '@renderer/stores/sessions'

export type SessionDialog = 'rename' | 'delete' | null

/**
 * A session's actions. A context menu is a Base UI menu, so the same items serve the row's
 * context menu, its More button and the top bar's title menu.
 */
export function SessionMenuItems({
  summary,
  onDialog,
}: {
  summary: SessionSummary
  onDialog: (dialog: SessionDialog) => void
}) {
  const { t } = useTranslation(['sidebar', 'common'])
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuItem onClick={() => onDialog('rename')}>{t('row.rename')}</DropdownMenuItem>
        {summary.origin !== 'subagent' && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{t('row.newSubSession')}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {agents.map((agent) => (
                <DropdownMenuItem
                  key={agent.id}
                  disabled={!isInstalled(agent)}
                  onClick={() => void createSession(agent.id, summary.projectPath, summary.id)}
                >
                  <AgentMark agent={agent.id} size={14} mono={!isInstalled(agent)} />
                  {agent.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuItem onClick={() => void closeSession(summary.id)}>
          {t('common:actions.close')}
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem variant="destructive" onClick={() => onDialog('delete')}>
          {t('row.deleteMenu')}
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </>
  )
}

/** The dialogs the menu's Rename and Delete open. */
export function SessionDialogs({
  summary,
  dialog,
  onDialog,
}: {
  summary: SessionSummary
  dialog: SessionDialog
  onDialog: (dialog: SessionDialog) => void
}) {
  const close = (open: boolean) => {
    if (!open) onDialog(null)
  }
  return (
    <>
      <Dialog open={dialog === 'rename'} onOpenChange={close}>
        <DialogContent showCloseButton={false}>
          {/* Mounted per opening, so the field starts from the current title. */}
          <RenameForm summary={summary} onDone={() => onDialog(null)} />
        </DialogContent>
      </Dialog>
      <DeleteSessionDialog
        sessionId={summary.id}
        title={sessionTitle(summary)}
        open={dialog === 'delete'}
        onOpenChange={close}
      />
    </>
  )
}

function RenameForm({ summary, onDone }: { summary: SessionSummary; onDone: () => void }) {
  const { t } = useTranslation(['sidebar', 'common'])
  const current = sessionTitle(summary)
  const [value, setValue] = useState(current)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (value.trim() === current) return onDone()
    setSaving(true)
    try {
      await renameSession(summary.id, value.trim() || null)
      onDone()
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t('row.renameTitle')}</DialogTitle>
        <DialogDescription>{t('row.renameHint')}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Input
          autoFocus
          value={value}
          maxLength={200}
          aria-label={t('row.renameTitle')}
          aria-invalid={error !== null}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setValue(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            // Enter that ends an IME composition must not submit half-typed text.
            if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229))
              event.preventDefault()
          }}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <Button type="submit" disabled={saving}>
          {t('row.renameSave')}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function DeleteSessionDialog({
  sessionId,
  title,
  open,
  onOpenChange,
}: {
  sessionId: string
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['sidebar', 'common'])
  const count = open ? descendantCount(sessionId) : 0
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('row.deleteTitle', { title })}</AlertDialogTitle>
          <AlertDialogDescription>
            {count > 0 ? t('row.deleteBodyWithSub', { count }) : t('row.deleteBody')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void deleteSession(sessionId)}>
            {t('row.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
