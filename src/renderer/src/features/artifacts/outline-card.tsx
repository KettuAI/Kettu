import { useMemo, useState } from 'react'
import { Comment01Icon, Search01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { DocHeading } from '@shared/artifact-runtime/document-sheet'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { TreeView, type TreeNode } from '@renderer/components/affect/tree-view'
import { setViewerState, useViewerState, type PagesFilter } from '@renderer/stores/artifact-viewer'
import { ViewerSlot } from './viewer-shell'
import { NoneHere } from './viewer-states'

/**
 * The left card of a document: its headings as a tree, the section on screen picked out, found by
 * its words and narrowed to the changed sections or those with comments. A row scrolls the sheet
 * to its heading.
 */
export function OutlineCard({
  artifactId,
  headings,
  current,
  changed,
  version,
  marks,
  comments,
  onPick,
  writing,
}: {
  artifactId: string
  headings: readonly DocHeading[]
  /** The section on screen, by its slug. */
  current: string | null
  /** The slugs of the sections the latest version changed, tagged with that version. */
  changed: ReadonlySet<string>
  version: number
  /** The version that last changed each changed section, when not `version`. */
  marks?: ReadonlyMap<string, number>
  /** Open threads by the slug of the section each is in. */
  comments: ReadonlyMap<string, number>
  onPick: (heading: DocHeading) => void
  /** The section an agent is writing, by its slug. */
  writing?: string | null
}) {
  const { t } = useTranslation('artifacts')
  const filter = useViewerState(artifactId, (s) => s.pagesFilter)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [folded, setFolded] = useState<string[]>([])
  const needle = query.trim().toLocaleLowerCase()
  const narrowed = needle !== '' || filter !== 'all'
  const commented = [...comments.values()].reduce((sum, n) => sum + n, 0)

  const { items, parents } = useMemo(() => {
    const keep = (h: DocHeading) =>
      (filter === 'all' ||
        (filter === 'changed' && changed.has(h.slug)) ||
        (filter === 'comments' && (comments.get(h.slug) ?? 0) > 0)) &&
      (needle === '' || h.text.toLocaleLowerCase().includes(needle))
    const node = (h: DocHeading): TreeNode => {
      const count = comments.get(h.slug) ?? 0
      const held = !!writing && writing === h.slug
      return {
        id: h.slug,
        label: h.text,
        meta:
          changed.has(h.slug) || count > 0 || held ? (
            <span className="k-pages__marks">
              {held && (
                <span className="k-pages__mark" data-writing="">
                  {t('viewer.writing.row')}
                </span>
              )}
              {changed.has(h.slug) && (
                <span className="k-pages__mark" data-changed="">
                  {t('pages.version', { version: marks?.get(h.slug) ?? version })}
                </span>
              )}
              {count > 0 && (
                <span className="k-pages__mark">
                  <HugeiconsIcon icon={Comment01Icon} size={11} strokeWidth={2} />
                  {count}
                </span>
              )}
            </span>
          ) : undefined,
      }
    }
    // A heading holds the deeper ones after it; narrowed, one that does not match stays only to
    // hold one that does.
    const roots: TreeNode[] = []
    const withChildren = new Set<string>()
    const stack: { level: number; node: TreeNode; kept: boolean }[] = []
    const attach = (entry: { level: number; node: TreeNode; kept: boolean }) => {
      const parent = stack[stack.length - 1]
      if (parent) {
        parent.node.children = [...(parent.node.children ?? []), entry.node]
        withChildren.add(parent.node.id)
      } else roots.push(entry.node)
    }
    const prune = (nodes: TreeNode[], kept: ReadonlySet<string>): TreeNode[] =>
      nodes.flatMap((n) => {
        const children = n.children ? prune(n.children, kept) : []
        if (!kept.has(n.id) && children.length === 0) return []
        return [{ ...n, children: children.length ? children : undefined }]
      })
    const kept = new Set<string>()
    for (const h of headings) {
      while (stack.length && stack[stack.length - 1]!.level >= h.level) stack.pop()
      const entry = { level: h.level, node: node(h), kept: keep(h) }
      if (entry.kept) kept.add(h.slug)
      attach(entry)
      stack.push(entry)
    }
    return { items: narrowed ? prune(roots, kept) : roots, parents: withChildren }
  }, [headings, filter, needle, narrowed, changed, comments, version, marks, writing, t])

  const expanded = narrowed ? [...parents] : [...parents].filter((slug) => !folded.includes(slug))

  return (
    <>
      <ViewerSlot slot="leftHead">
        <button
          type="button"
          className="avs-card__close"
          aria-label={t('outline.search')}
          title={t('outline.search')}
          aria-pressed={searching}
          onClick={() => {
            setSearching((on) => !on)
            setQuery('')
          }}
        >
          <HugeiconsIcon icon={Search01Icon} size={14} strokeWidth={1.9} />
        </button>
      </ViewerSlot>
      <ViewerSlot slot="left">
        <div className="k-pages">
          {searching && (
            <input
              autoFocus
              type="search"
              value={query}
              placeholder={t('outline.find')}
              aria-label={t('outline.search')}
              className="k-pages__find"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  setSearching(false)
                  setQuery('')
                }
              }}
            />
          )}
          <div className="k-pages__filter">
            <SegmentedControl<PagesFilter>
              variant="tray"
              size="sm"
              aria-label={t('outline.filter')}
              value={filter}
              onChange={(next) => setViewerState(artifactId, { pagesFilter: next })}
              options={[
                { value: 'all', label: t('pages.all') },
                { value: 'changed', label: t('pages.changed'), count: changed.size },
                { value: 'comments', label: t('pages.comments'), count: commented },
              ]}
            />
          </div>
          <div className="k-pages__tree">
            {narrowed && items.length === 0 ? (
              <NoneHere
                text={
                  needle
                    ? t('outline.noMatch', { query: query.trim() })
                    : filter === 'changed'
                      ? t('outline.noChanges')
                      : t('outline.noComments')
                }
                onShowAll={() => {
                  setQuery('')
                  setViewerState(artifactId, { pagesFilter: 'all' })
                }}
              />
            ) : (
              <TreeView
                items={items}
                expanded={expanded}
                onExpandedChange={
                  narrowed
                    ? undefined
                    : (next) => setFolded([...parents].filter((slug) => !next.includes(slug)))
                }
                selected={current}
                onSelect={(slug) => {
                  const heading = headings.find((h) => h.slug === slug)
                  if (heading) onPick(heading)
                }}
                guides={false}
                emptyText={
                  needle
                    ? t('outline.noMatch', { query: query.trim() })
                    : filter === 'changed'
                      ? t('outline.noChanges')
                      : filter === 'comments'
                        ? t('outline.noComments')
                        : t('outline.none')
                }
                aria-label={t('outline.title')}
              />
            )}
          </div>
        </div>
      </ViewerSlot>
    </>
  )
}
