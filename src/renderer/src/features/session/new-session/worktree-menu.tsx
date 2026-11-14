import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, type Variants } from 'motion/react'
import {
  Alert02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  CloudIcon,
  GitBranchIcon,
  GitCommitIcon,
  Search01Icon,
  SparklesIcon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import { branchProblem } from '@shared/branch-name'
import type { BranchList, GitStatus } from '@shared/git'
import { FolderMark } from '@renderer/components/affect/assistant-home'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { Button } from '@renderer/components/ui/button'
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  useComboboxFilter,
} from '@renderer/components/ui/combobox'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@renderer/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Glyph } from '@renderer/features/shell/glyph'
import { shortAgo } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { glide } from '@renderer/lib/motion'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { prefersReducedMotion } from '@renderer/stores/settings'
import {
  chooseBase,
  chooseWhere,
  keepTemplate,
  namedBranch,
  slugFrame,
  templateFailed,
  useWorktreeChoice,
  writeSlug,
} from '@renderer/stores/worktree-choice'
import { shortOid, WORKTREE_ICON } from '../worktree/worktree-icon'
import { currentBase } from './worktree-base'

type Page = 'home' | 'base' | 'name'
type Where = 'local' | 'worktree'
type Loaded = { list: BranchList; error: null } | { list: null; error: string } | null

// A page pushes the one before aside; going back pushes it in again. `custom` is 1 going in.
const SLIDE: Variants = {
  enter: (into: number) => ({ x: into * 28, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (into: number) => ({ x: into * -28, opacity: 0 }),
}

/**
 * New session's place to work, in the tray where the branch was: Local, the project folder, or a
 * new worktree, whose base and branch name each open a page of their own. Remembered per project.
 */
export function WorktreeMenu({ projectPath, status }: { projectPath: string; status: GitStatus }) {
  const { t } = useTranslation('session')
  const where = useWorktreeChoice((s) => s.where[projectPath] ?? 'local')
  const picked = useWorktreeChoice((s) => s.base[projectPath] ?? null)
  const template = useWorktreeChoice((s) => s.template[projectPath])
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<Page>('home')
  const [into, setInto] = useState(1)
  const [read, setRead] = useState<{ projectPath: string; loaded: Loaded } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const current = currentBase(status)
  const base = picked ?? current
  const worktree = where === 'worktree'
  // The last list read stays while it is read again, but never another project's.
  const loaded = read?.projectPath === projectPath ? read.loaded : null

  useEffect(() => {
    if (!open || !worktree) return
    let live = true
    host('git.branches', { projectPath }).then(
      (list) => live && setRead({ projectPath, loaded: { list, error: null } }),
      (error: unknown) =>
        live && setRead({ projectPath, loaded: { list: null, error: errorMessage(error) } }),
    )
    return () => {
      live = false
    }
  }, [open, worktree, projectPath, attempt])

  // Read again on each opening, since the project's settings may have changed it; a branch named
  // for the send needs it even while closed.
  const needTemplate = worktree && (open || template === undefined)
  useEffect(() => {
    if (!needTemplate) return
    let live = true
    host('projects.worktreeSettings', { path: projectPath }).then(
      (settings) => live && keepTemplate(projectPath, settings.branchTemplate),
      (error: unknown) => live && templateFailed(projectPath, errorMessage(error)),
    )
    return () => {
      live = false
    }
  }, [needTemplate, projectPath])

  const go = (next: Page) => {
    setInto(next === 'home' ? -1 : 1)
    setPage(next)
  }
  const label = (value: string | null): string =>
    value && value === status.head.oid && !status.head.branch ? shortOid(value) : (value ?? '')

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (!next && details.reason === 'escape-key' && page !== 'home') {
          details.cancel()
          go('home')
          return
        }
        if (next) {
          setPage('home')
          setInto(1)
        }
        setOpen(next)
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t('worktree.where')}
            className="ui-as-tray-link kettu-tray-link--branch"
          />
        }
      >
        <Glyph
          icon={worktree ? WORKTREE_ICON : status.head.branch ? GitBranchIcon : GitCommitIcon}
          size={13}
        />
        <span className="kettu-tray-link__text">
          <Trans
            t={t}
            i18nKey={worktree ? 'worktree.newTrigger' : 'worktree.localTrigger'}
            values={{ branch: label(worktree ? base : current) }}
            components={{ name: <span className="font-mono" /> }}
          />
        </span>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-85 gap-0 p-0">
        <Pages page={page} into={into}>
          {page === 'home' ? (
            <Home
              projectPath={projectPath}
              status={status}
              where={where}
              base={base}
              label={label}
              loaded={loaded}
              onPage={go}
            />
          ) : page === 'base' ? (
            <BasePage
              status={status}
              base={base}
              loaded={loaded}
              label={label}
              onRetry={() => {
                setRead(null)
                setAttempt((n) => n + 1)
              }}
              onBack={() => go('home')}
              onChoose={(value) => {
                chooseBase(projectPath, value === current ? null : value)
                go('home')
              }}
            />
          ) : (
            <NamePage projectPath={projectPath} onBack={() => go('home')} />
          )}
        </Pages>
      </PopoverContent>
    </Popover>
  )
}

/** The pages, each sliding in from the side it lies on, with the popover's height following. */
function Pages({ page, into, children }: { page: Page; into: number; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | 'auto'>('auto')
  const reduce = prefersReducedMotion()

  useLayoutEffect(() => {
    const element = inner.current
    if (!element) return
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <motion.div
      initial={false}
      animate={{ height }}
      transition={reduce ? { duration: 0 } : glide}
      className="overflow-hidden"
    >
      <div ref={inner} className="relative">
        <AnimatePresence initial={false} mode="popLayout" custom={into}>
          <motion.div
            key={page}
            custom={into}
            variants={SLIDE}
            initial="enter"
            animate="center"
            exit="exit"
            transition={reduce ? { duration: 0 } : glide}
            className="flex flex-col p-1.5"
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

function Home({
  projectPath,
  status,
  where,
  base,
  label,
  loaded,
  onPage,
}: {
  projectPath: string
  status: GitStatus
  where: Where
  base: string | null
  label: (value: string | null) => string
  loaded: Loaded
  onPage: (page: Page) => void
}) {
  const { t } = useTranslation('session')
  const slug = useWorktreeChoice((s) => s.slug)
  const branch = useWorktreeChoice((s) => namedBranch(s, projectPath))
  const template = useWorktreeChoice((s) => s.template[projectPath])
  const { staged, unstaged, untracked, conflicted } = status.changes
  const uncommitted = staged + unstaged + untracked + conflicted
  const kind = baseKind(base, status, loaded)
  const oid = baseOid(base, status, loaded)
  const frame = template === undefined ? null : slugFrame(template)
  const invalid = !!branch && branchProblem(branch) !== null

  return (
    <>
      <SegmentedControl<Where>
        aria-label={t('worktree.where')}
        variant="tray"
        fullWidth
        value={where}
        onChange={(next) => chooseWhere(projectPath, next)}
        options={[
          { value: 'local', label: t('worktree.local'), icon: <FolderMark /> },
          {
            value: 'worktree',
            label: t('worktree.new'),
            icon: <Glyph icon={WORKTREE_ICON} size={15} />,
          },
        ]}
      />
      {where === 'local' ? (
        <div className="flex flex-col gap-1.5 px-1.5 pt-2.5 pb-0.75">
          <p className="flex min-w-0 items-start gap-1.75 text-ui text-secondary">
            <Glyph
              icon={status.head.branch ? GitBranchIcon : GitCommitIcon}
              size={13}
              className="mt-0.5 shrink-0 text-icon"
            />
            <span className="min-w-0">
              <Trans
                t={t}
                i18nKey="worktree.localWorks"
                values={{ branch: label(currentBase(status)) }}
                components={{
                  name: <span className="font-mono text-code wrap-anywhere text-primary" />,
                }}
              />
            </span>
          </p>
          <p className="text-meta text-tertiary">{t('worktree.localHint')}</p>
        </div>
      ) : (
        <>
          <div className="mt-1.5 overflow-hidden rounded-lg shadow-card">
            <Row label={t('worktree.basedOn')} onClick={() => onPage('base')}>
              <Glyph icon={KIND_ICONS[kind]} size={13} className="shrink-0 text-icon" />
              <span className="min-w-0 truncate font-mono text-code">{label(base)}</span>
              {oid && kind !== 'commit' && (
                <span className="shrink-0 font-mono text-code text-tertiary">{shortOid(oid)}</span>
              )}
            </Row>
            <Row label={t('worktree.branch')} onClick={() => onPage('name')} divided>
              {slug ? (
                <span
                  className={cn('min-w-0 truncate font-mono text-code', invalid && 'text-danger')}
                >
                  <span className={invalid ? undefined : 'text-tertiary'}>{frame?.before}</span>
                  {slug}
                  <span className={invalid ? undefined : 'text-tertiary'}>
                    {frame?.after(slug)}
                  </span>
                </span>
              ) : (
                <>
                  <span className="inline-flex shrink-0 items-center gap-1 text-meta font-medium text-primary">
                    <Glyph icon={SparklesIcon} size={12} className="text-send" />
                    {t('worktree.auto')}
                  </span>
                  <span className="min-w-0 truncate text-meta text-tertiary">
                    {t('worktree.autoHint')}
                  </span>
                </>
              )}
            </Row>
          </div>
          {uncommitted > 0 && (
            <p className="flex items-start gap-1.75 px-1.5 pt-2.25 pb-0.75 text-meta text-warning">
              <Glyph icon={Alert02Icon} size={13} className="mt-px shrink-0" />
              <span className="min-w-0">{t('worktree.uncommitted', { count: uncommitted })}</span>
            </p>
          )}
        </>
      )}
    </>
  )
}

/** A setting of the new worktree: its name, its value and the way to its page. */
function Row({
  label,
  divided,
  onClick,
  children,
}: {
  label: string
  divided?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'grid min-h-9.5 w-full cursor-default grid-cols-[62px_minmax(0,1fr)_14px] items-center gap-2 pr-2.5 pl-2.75 text-left outline-hidden select-none hover:bg-accent focus-visible:bg-accent',
        divided && 'border-t border-subtle',
      )}
    >
      <span className="truncate text-meta text-tertiary">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-ui">{children}</span>
      <Glyph icon={ArrowRight01Icon} size={13} className="text-tertiary" />
    </button>
  )
}

function PageHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const { t } = useTranslation('session')
  return (
    <div className="mb-0.5 grid h-8 grid-cols-[28px_1fr_28px] items-center">
      <Button variant="ghost" size="icon-sm" aria-label={t('worktree.back')} onClick={onBack}>
        <Glyph icon={ArrowLeft01Icon} size={15} />
      </Button>
      <span className="truncate text-center text-menu font-medium">{title}</span>
    </div>
  )
}

interface BaseGroup {
  value: 'local' | 'remote'
  items: string[]
}

function BasePage({
  status,
  base,
  loaded,
  label,
  onRetry,
  onBack,
  onChoose,
}: {
  status: GitStatus
  base: string | null
  loaded: Loaded
  label: (value: string | null) => string
  onRetry: () => void
  onBack: () => void
  onChoose: (value: string) => void
}) {
  const { t } = useTranslation('session')
  const now = useNow()
  const { contains } = useComboboxFilter()
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const current = currentBase(status)
  const list = loaded?.list ?? null

  // Focused without scrolling, since the page is still sliding into the clipped popover.
  useEffect(() => {
    if (list) input.current?.focus({ preventScroll: true })
  }, [list])

  const times = useMemo(() => {
    const map = new Map<string, number | null>()
    for (const b of list?.branches ?? []) map.set(b.name, b.committedAt)
    for (const b of list?.remoteBranches ?? []) map.set(b.name, b.committedAt)
    return map
  }, [list])
  const groups = useMemo((): BaseGroup[] => {
    if (!list) return []
    // The current branch or commit first, then the others by their last commit.
    const local = list.branches.map((b) => b.name).filter((name) => name !== current)
    if (current) local.unshift(current)
    if (base && base !== current && !times.has(base)) local.push(base)
    const remote = list.remoteBranches.map((b) => b.name).filter((name) => !local.includes(name))
    return [
      { value: 'local', items: local },
      { value: 'remote', items: remote },
    ]
  }, [list, current, base, times])

  return (
    <>
      <PageHeader title={t('worktree.basedOn')} onBack={onBack} />
      {loaded?.error ? (
        <div className="flex flex-col items-start gap-2 px-1.5 pt-1 pb-1.5">
          <p className="text-meta text-danger" title={loaded.error}>
            {t('worktree.branchesFailed', { message: loaded.error.split('\n')[0] })}
          </p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t('worktree.retry')}
          </Button>
        </div>
      ) : !list ? (
        <div aria-busy className="flex flex-col gap-3 px-2 pt-3 pb-2.5">
          <Skeleton className="h-3 w-44" />
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-52" />
          <Skeleton className="h-3 w-36" />
        </div>
      ) : (
        <Combobox
          inline
          open
          autoHighlight
          items={groups}
          value={base}
          inputValue={query}
          onInputValueChange={setQuery}
          onValueChange={(value: string | null) => value && onChoose(value)}
          onOpenChange={(next, details) => {
            if (!next && details.reason === 'escape-key') onBack()
          }}
          itemToStringLabel={(value: string) => label(value)}
          filter={(value: string, search: string) => contains(label(value), search)}
        >
          <ComboboxInput
            ref={input}
            showTrigger={false}
            placeholder={t('worktree.findBranch')}
            aria-label={t('worktree.findBranch')}
            spellCheck={false}
            className="mb-1 h-8 rounded-none border-0 border-b border-subtle bg-transparent shadow-none has-[[data-slot=input-group-control]:focus-visible]:border-subtle has-[[data-slot=input-group-control]:focus-visible]:shadow-none"
          >
            <InputGroupAddon>
              <Glyph icon={Search01Icon} size={14} className="text-icon" />
            </InputGroupAddon>
          </ComboboxInput>
          <ComboboxEmpty className="flex justify-center px-2 py-4 text-ui text-tertiary empty:hidden">
            {t('worktree.noBranchMatch', { query: query.trim() })}
          </ComboboxEmpty>
          <ComboboxList className="max-h-72 p-0 data-empty:hidden">
            {(group: BaseGroup) =>
              group.items.length > 0 && (
                <ComboboxGroup key={group.value} items={group.items}>
                  <ComboboxLabel>
                    {t(
                      group.value === 'local'
                        ? 'worktree.localBranches'
                        : 'worktree.remoteBranches',
                    )}
                  </ComboboxLabel>
                  <ComboboxCollection>
                    {(name: string) => {
                      const at = times.get(name) ?? null
                      const commit = name === status.head.oid && !status.head.branch
                      return (
                        <ComboboxItem key={name} value={name} className="h-7.5 gap-2 text-control">
                          <Glyph
                            icon={
                              group.value === 'remote'
                                ? CloudIcon
                                : commit
                                  ? GitCommitIcon
                                  : GitBranchIcon
                            }
                            size={14}
                            className="text-icon"
                          />
                          <span className="min-w-0 truncate font-mono text-code">
                            {label(name)}
                          </span>
                          {name === current && (
                            <span className="shrink-0 rounded-sm bg-muted px-1.25 text-caption font-medium text-secondary">
                              {t('worktree.current')}
                            </span>
                          )}
                          {at !== null && (
                            <span className="ml-auto shrink-0 pl-3 text-hint text-tertiary tabular">
                              {shortAgo(at, now)}
                            </span>
                          )}
                        </ComboboxItem>
                      )
                    }}
                  </ComboboxCollection>
                </ComboboxGroup>
              )
            }
          </ComboboxList>
        </Combobox>
      )}
    </>
  )
}

function NamePage({ projectPath, onBack }: { projectPath: string; onBack: () => void }) {
  const { t } = useTranslation('session')
  const slug = useWorktreeChoice((s) => s.slug)
  const branch = useWorktreeChoice((s) => namedBranch(s, projectPath))
  const template = useWorktreeChoice((s) => s.template[projectPath])
  const failed = useWorktreeChoice((s) => s.templateError[projectPath] ?? null)
  const input = useRef<HTMLInputElement>(null)
  const frame = template === undefined ? null : slugFrame(template)
  const invalid = !!branch && branchProblem(branch) !== null
  const example = frame ? frame.before + EXAMPLE_SLUG + frame.after(EXAMPLE_SLUG) : EXAMPLE_SLUG

  useEffect(() => {
    const element = input.current
    if (!element) return
    element.focus({ preventScroll: true })
    element.setSelectionRange(element.value.length, element.value.length)
  }, [])

  return (
    <>
      <PageHeader title={t('worktree.branchName')} onBack={onBack} />
      <div className="flex flex-col gap-2 px-0.5 pt-0.5 pb-1">
        <InputGroup className="h-8.5">
          {frame?.before && (
            <InputGroupAddon className="pr-0 font-mono text-code font-normal text-tertiary">
              {frame.before}
            </InputGroupAddon>
          )}
          <InputGroupInput
            ref={input}
            value={slug ?? ''}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            maxLength={100}
            aria-label={t('worktree.branchName')}
            aria-invalid={invalid || undefined}
            placeholder={t('worktree.namedForYou')}
            onChange={(event) => writeSlug(event.target.value.trim())}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229)
                return
              event.preventDefault()
              if (!invalid) onBack()
            }}
            className={cn(
              'font-mono text-code placeholder:font-sans',
              frame?.before && 'pl-0!',
              frame && slug && frame.after(slug) && 'pr-0!',
            )}
          />
          {frame && slug && frame.after(slug) && (
            <InputGroupAddon
              align="inline-end"
              className="pl-0 font-mono text-code font-normal text-tertiary"
            >
              {frame.after(slug)}
            </InputGroupAddon>
          )}
        </InputGroup>
        {failed ? (
          <p className="text-meta text-danger" title={failed}>
            {t('worktree.templateFailed', { message: failed.split('\n')[0] })}
          </p>
        ) : invalid ? (
          <p className="text-meta text-danger">{t('worktree.branchInvalid')}</p>
        ) : (
          <p className="text-meta text-tertiary">
            <Trans
              t={t}
              i18nKey="worktree.nameHelp"
              values={{ example }}
              components={{ code: <span className="font-mono text-code" /> }}
            />
          </p>
        )}
      </div>
    </>
  )
}

const EXAMPLE_SLUG = 'fix-rss-feed-dates'

type BaseKind = 'branch' | 'remote' | 'commit'

const KIND_ICONS: Record<BaseKind, IconSvgElement> = {
  branch: GitBranchIcon,
  remote: CloudIcon,
  commit: GitCommitIcon,
}

function baseKind(base: string | null, status: GitStatus, loaded: Loaded): BaseKind {
  if (base && base === status.head.oid && !status.head.branch) return 'commit'
  if (base && loaded?.list?.remoteBranches.some((b) => b.name === base)) return 'remote'
  return 'branch'
}

/** The base's commit: the checked-out one's from the status, another's from the branch list. */
function baseOid(base: string | null, status: GitStatus, loaded: Loaded): string | null {
  if (!base) return null
  if (base === currentBase(status)) return status.head.oid
  const list = loaded?.list
  return (
    list?.branches.find((b) => b.name === base)?.oid ??
    list?.remoteBranches.find((b) => b.name === base)?.oid ??
    null
  )
}

// One line, cut short when it doesn't fit: the popover holds the whole of it.
const NOTE = 'flex h-5 min-w-0 items-center gap-1.5 px-2.75 text-xs text-secondary'

/**
 * Under the tray while New worktree is chosen: the base it is cut from and the branch it starts
 * on, or that Kettu names it when the message is sent.
 */
export function WorktreeNote({ projectPath, status }: { projectPath: string; status: GitStatus }) {
  const { t } = useTranslation('session')
  const where = useWorktreeChoice((s) => s.where[projectPath] ?? 'local')
  const picked = useWorktreeChoice((s) => s.base[projectPath] ?? null)
  const branch = useWorktreeChoice((s) => namedBranch(s, projectPath))
  const current = currentBase(status)
  const base = picked ?? current
  // The line stays while Local is chosen, so switching never moves the centered composer.
  if (where !== 'worktree' || !base) return <p aria-hidden className={NOTE} />
  // Only the current branch's or commit's oid is known here.
  const oid = base === current ? status.head.oid : null
  const detached = !status.head.branch && base === status.head.oid
  const named = !!branch && branchProblem(branch) === null
  const key = named
    ? oid && !detached
      ? 'worktree.noteNamedAt'
      : 'worktree.noteNamed'
    : oid && !detached
      ? 'worktree.noteAutoAt'
      : 'worktree.noteAuto'
  const code = (text: string) => <b className="font-mono text-code font-normal">{text}</b>
  return (
    <p className={NOTE}>
      <Glyph icon={WORKTREE_ICON} size={12} className="shrink-0 text-icon" />
      <span className="min-w-0 truncate">
        <Trans
          t={t}
          i18nKey={key}
          components={{
            base: detached ? code(shortOid(base)) : <b className="font-medium">{base}</b>,
            oid: code(oid ? shortOid(oid) : ''),
            branch: code(named ? branch : ''),
          }}
        />
      </span>
    </p>
  )
}
