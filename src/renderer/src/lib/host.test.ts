import { describe, expect, it } from 'vitest'
import { artifactHost, artifactRefOf, forgetHostSessions, learnArtifactHost, routeOf } from './host'

const HOST_A = 'a'.repeat(32)
const HOST_B = 'b'.repeat(32)
const id = (n: number): string => `art_01J9Z3K4V5W6X7Y8Z9A0B1C2D${n}`

describe('the host an artifact request goes to', () => {
  it('is this computer for an artifact no other host has named', () => {
    expect(routeOf('artifacts.read', { id: id(0) })).toBeNull()
    expect(artifactRefOf(id(0))).toBe(id(0))
  })

  it('is the host that keeps the artifact, for every request that names it', () => {
    learnArtifactHost(id(1), HOST_A)
    expect(routeOf('artifacts.read', { id: id(1) })).toBe(HOST_A)
    expect(routeOf('artifacts.delete', { id: id(1), permanently: true })).toBe(HOST_A)
    expect(routeOf('artifacts.runtime', { artifactId: id(1), message: {} })).toBe(HOST_A)
    expect(artifactRefOf(id(1))).toBe(`${HOST_A}:${id(1)}`)
  })

  it('goes by the artifact only for artifact requests', () => {
    learnArtifactHost(id(2), HOST_A)
    expect(routeOf('attachments.read', { id: id(2) })).toBeNull()
    expect(routeOf('sessions.get', { id: id(2) })).toBeNull()
  })

  it('never leaves this computer for an artifact it keeps, whatever another host claims', () => {
    learnArtifactHost(id(3), null)
    learnArtifactHost(id(3), HOST_A)
    expect(artifactHost(id(3))).toBeNull()
    expect(routeOf('artifacts.comment', { id: id(3), body: 'x' })).toBeNull()
  })

  it('returns to this computer once this computer is known to keep the artifact', () => {
    learnArtifactHost(id(4), HOST_A)
    learnArtifactHost(id(4), null)
    expect(artifactHost(id(4))).toBeNull()
  })

  it('forgets the artifacts of a host this computer no longer connects to, and no others', () => {
    learnArtifactHost(id(5), HOST_A)
    learnArtifactHost(id(6), HOST_B)
    forgetHostSessions(HOST_A)
    expect(artifactHost(id(5))).toBeNull()
    expect(artifactHost(id(6))).toBe(HOST_B)
  })
})
