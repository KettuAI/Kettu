import { describe, expect, it } from 'vitest'
import type { ArtifactBrief } from '@shared/host-control'
import { AUTO_QUIET_MS, planAuto } from './auto'
import type { AutoState, PublishedPage } from './store'

const NOW = 1_000_000
const ACCOUNT = '6f9619ff-8b86-d011-b42d-00c04fc964ff'
const A = `art_${'A'.repeat(26)}`
const B = `art_${'B'.repeat(26)}`

const auto: AutoState = {
  enabled: true,
  confirmed: true,
  since: 500_000,
  accountId: ACCOUNT,
  declined: [],
}

function artifact(overrides: Partial<ArtifactBrief> = {}): ArtifactBrief {
  return {
    id: A,
    version: 1,
    createdAt: 600_000,
    updatedAt: 600_000,
    deleted: false,
    ...overrides,
  }
}

function page(overrides: Partial<PublishedPage> = {}): PublishedPage {
  return {
    id: A,
    target: 'kettu',
    ref: 'abcdefghij',
    url: 'https://abcdefghij.pages.example/',
    version: 1,
    publishedAt: 600_000,
    accountId: ACCOUNT,
    accountEmail: null,
    access: 'private',
    code: null,
    ...overrides,
  }
}

const plan = (
  artifacts: ArtifactBrief[],
  pages: PublishedPage[] = [],
  state: Partial<AutoState> = {},
) => planAuto({ artifacts, pages, auto: { ...auto, ...state }, accountId: ACCOUNT, now: NOW })

describe('planAuto', () => {
  it('publishes an artifact made since the switch took effect', () => {
    expect(plan([artifact()]).steps).toEqual([{ kind: 'publish', id: A, version: 1 }])
  })

  it('leaves an artifact that existed before alone', () => {
    expect(plan([artifact({ createdAt: 400_000 })]).steps).toEqual([])
  })

  it('publishes nothing while signed out', () => {
    expect(plan([artifact()], [], { since: null }).steps).toEqual([])
  })

  it('leaves an artifact the user unpublished alone, and one in Recently deleted', () => {
    expect(plan([artifact()], [], { declined: [A] }).steps).toEqual([])
    expect(plan([artifact({ deleted: true })]).steps).toEqual([])
  })

  it('updates a page on Kettu at any level, whenever it was published', () => {
    for (const access of ['private', 'code', 'public'] as const) {
      const published = page({ access, code: access === 'code' ? 'abcd' : null })
      expect(plan([artifact({ version: 3, createdAt: 100 })], [published]).steps).toEqual([
        { kind: 'update', id: A, version: 3 },
      ])
    }
  })

  it('does not update a page that is current, on Cloudflare, of another account or deleted', () => {
    const later = artifact({ version: 2, createdAt: 100 })
    expect(plan([artifact({ createdAt: 100 })], [page()]).steps).toEqual([])
    expect(
      plan([later], [page({ target: 'cloudflare', accountId: 'f'.repeat(32) })]).steps,
    ).toEqual([])
    expect(plan([later], [page({ accountId: 'someone-else' })]).steps).toEqual([])
    expect(plan([{ ...later, deleted: true }], [page()]).steps).toEqual([])
  })

  it('waits until an artifact has been quiet, and says for how long', () => {
    const busy = artifact({ updatedAt: NOW - 1_000 })
    expect(plan([busy])).toEqual({ steps: [], wait: AUTO_QUIET_MS - 1_000 })
  })

  it('does not let a busy artifact hold back a quiet one, and does the oldest first', () => {
    const result = plan([
      artifact({ id: A, updatedAt: NOW - 1_000 }),
      artifact({ id: B, updatedAt: NOW - 60_000 }),
    ])
    expect(result.steps).toEqual([{ kind: 'publish', id: B, version: 1 }])
    expect(result.wait).toBe(AUTO_QUIET_MS - 1_000)
  })
})
