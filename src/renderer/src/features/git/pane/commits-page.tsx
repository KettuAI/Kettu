import { Download04Icon, Upload04Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { GitStatus } from '@shared/git'
import { CommitRow, PushLine, TreeLine } from '../branch-tree'
import { useCommitCards } from '../commit-cards'
import { Count, PartHead } from '../rows'
import { pushNow, runStep } from '../steps'
import { planSync, pushTargetOf, PUSH_LABEL, PUSHING } from '../sync'
import { useGitStore } from '@renderer/stores/git'
import { ActionBtn } from './pane-ui'

/** The branch's commits as a tree: those only this computer has, the push line, the pushed ones. */
export function CommitsPage({ status }: { status: GitStatus }) {
  const { t } = useTranslation('git')
  const { projectPath, upstream, defaultBranch, head, commits } = status
  const gh = useGitStore((s) => s.tools?.gh.state ?? null)
  const running = useGitStore((s) => s.running[projectPath] ?? null)
  const cards = useCommitCards()
  const behind = upstream?.behind ?? 0
  const local = commits.filter((commit) => !commit.pushed)
  const pushed = commits.filter((commit) => commit.pushed)
  const plan = planSync(status, gh)
  const remote = pushTargetOf(status)?.remote ?? status.remote?.name ?? ''
  const onDefault = head.branch !== null && head.branch === defaultBranch
  // Nothing to push to from a diverged branch, a stopped operation or without a way to push.
  const kind = plan.push.kind
  const action =
    plan.push.enabled &&
    behind === 0 &&
    !status.operation &&
    (kind === 'push' || kind === 'publishBranch' || kind === 'publishRepo')
      ? kind
      : null
  const pushing = running !== null && PUSHING.has(running.kind)
  const nothing = () => {}

  if (commits.length === 0 && behind === 0) {
    return (
      <div className="grid flex-1 place-items-center content-center gap-1.5 px-6 py-10 text-center">
        <b className="text-row font-semibold">{t('pane.commits.emptyTitle')}</b>
        <p className="max-w-72 text-small text-tertiary">
          {defaultBranch && !onDefault
            ? t('pane.commits.emptyFrom', { base: defaultBranch })
            : t('pane.commits.emptyText')}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col pb-2">
      {behind > 0 && (
        <>
          <PartHead>
            <span className="text-warning">{t('pane.commits.toPull')}</span>
            <Count>{behind}</Count>
            <span className="flex-1" />
            <ActionBtn
              icon={Download04Icon}
              label={t('sync.pull')}
              busy={running?.kind === 'pull'}
              disabled={!plan.pull.enabled || running !== null}
              onClick={() => void runStep(projectPath, { kind: 'pull' })}
            />
          </PartHead>
          <div className="relative">
            <TreeLine kind="pull" end={t('tree.notPulled')}>
              <span className="text-tertiary">
                {t('tree.newOnRemote', { count: behind, remote })}
              </span>
            </TreeLine>
          </div>
        </>
      )}
      <div className="relative">
        <span
          aria-hidden
          className="absolute top-3.5 bottom-3.5 left-[8.25px] w-[1.5px] bg-border-strong"
        />
        {local.length > 0 && (
          <PartHead>
            <span>{t('pane.commits.notPushed')}</span>
            <Count>{local.length}</Count>
            <span className="flex-1" />
            {action && (
              <ActionBtn
                primary
                icon={Upload04Icon}
                label={
                  action === 'push'
                    ? t('next.action.push', { count: local.length })
                    : t(PUSH_LABEL[action])
                }
                busy={pushing}
                disabled={running !== null && !pushing}
                onClick={() => pushNow(projectPath)}
              />
            )}
          </PartHead>
        )}
        {local.map((commit) => (
          <CommitRow
            key={commit.oid}
            status={status}
            commit={commit}
            cards={cards}
            onOpened={nothing}
            pane
          />
        ))}
        {!status.operation && (
          <PushLine
            status={status}
            remote={remote}
            localCount={local.length}
            behind={behind}
            published={upstream !== null}
            attention={(local.length > 0 || upstream === null) && behind === 0}
            action={null}
            busy={false}
            label=""
            onPush={nothing}
          />
        )}
        {pushed.length > 0 && (
          <PartHead>
            <span>{t('pane.commits.pushed')}</span>
            <Count>{pushed.length}</Count>
          </PartHead>
        )}
        {pushed.map((commit) => (
          <CommitRow
            key={commit.oid}
            status={status}
            commit={commit}
            cards={cards}
            onOpened={nothing}
            pane
          />
        ))}
        {defaultBranch && !onDefault && (
          <TreeLine kind="base">
            <span className="text-tertiary">
              {t('tree.from')} <span className="font-mono text-code-sm">{defaultBranch}</span>
            </span>
          </TreeLine>
        )}
      </div>
    </div>
  )
}
