import { describe, expect, it } from 'vitest'
import { ARTIFACT_CSP } from '../artifacts/policy'
import { headersFile, pageHeaders, PUBLISHED_CSP, withMeta } from './page'

const META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta name="robots" content="noindex">`

describe('the published page', () => {
  it('sends the network policy, no referrer and no indexing with every path', () => {
    expect(headersFile(pageHeaders())).toBe(
      [
        '/*',
        `  Content-Security-Policy: ${PUBLISHED_CSP}`,
        '  X-Robots-Tag: noindex',
        '  Referrer-Policy: no-referrer',
        '  X-Content-Type-Options: nosniff',
        '',
      ].join('\n'),
    )
  })

  it('keeps frame-ancestors in the header, where it works', () => {
    expect(PUBLISHED_CSP).toBe(`${ARTIFACT_CSP}; frame-ancestors 'none'`)
    expect(pageHeaders()['Content-Security-Policy']).toContain("frame-ancestors 'none'")
  })
})

describe('withMeta', () => {
  it('puts the policy first in a head that exists', () => {
    expect(withMeta('<html><head><title>Report</title></head><body></body></html>')).toBe(
      `<html><head>${META}<title>Report</title></head><body></body></html>`,
    )
  })

  it('finds an upper-case head', () => {
    expect(withMeta('<HTML><HEAD><title>x</title></HEAD></HTML>')).toBe(
      `<HTML><HEAD>${META}<title>x</title></HEAD></HTML>`,
    )
  })

  it('starts the head where there is none, after the doctype and html', () => {
    expect(withMeta('<!doctype html><html lang="en"><body>x</body></html>')).toBe(
      `<!doctype html><html lang="en">${META}<body>x</body></html>`,
    )
    expect(withMeta('<!DOCTYPE html><p>x')).toBe(`<!DOCTYPE html>${META}<p>x`)
    expect(withMeta('<html><body>x</body></html>')).toBe(`<html>${META}<body>x</body></html>`)
    expect(withMeta('just text')).toBe(`${META}just text`)
  })

  it('keeps a byte order mark at the start', () => {
    const bom = String.fromCharCode(0xfeff)
    expect(withMeta(`${bom}<!doctype html><html><body>x`)).toBe(
      `${bom}<!doctype html><html>${META}<body>x`,
    )
  })

  it('reads past comments and never takes a head inside one', () => {
    expect(withMeta('<!doctype html><!-- <head> is not one --><html><head></head></html>')).toBe(
      `<!doctype html><!-- <head> is not one --><html><head>${META}</head></html>`,
    )
    expect(withMeta('<!-- <head> --><!doctype html><p>x')).toBe(
      `<!-- <head> --><!doctype html>${META}<p>x`,
    )
  })

  it('does not take a header or a script for the head', () => {
    expect(withMeta('<header>x</header><body>y')).toBe(`${META}<header>x</header><body>y`)
  })
})
