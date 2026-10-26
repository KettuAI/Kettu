import { describe, expect, it } from 'vitest'
import { addressParts, addressText, isLocalHost, normalizeAddress } from './address'

describe('normalizeAddress', () => {
  it('opens a bare address over https', () => {
    expect(normalizeAddress('example.com')).toBe('https://example.com/')
    expect(normalizeAddress('  example.com/a?b=1#c  ')).toBe('https://example.com/a?b=1#c')
    expect(normalizeAddress('EXAMPLE.com')).toBe('https://example.com/')
    expect(normalizeAddress('example.com:8443')).toBe('https://example.com:8443/')
  })

  it('opens a local dev host over http', () => {
    expect(normalizeAddress('localhost:5173/login')).toBe('http://localhost:5173/login')
    expect(normalizeAddress('127.0.0.1:3000')).toBe('http://127.0.0.1:3000/')
    expect(normalizeAddress('[::1]:8080/x')).toBe('http://[::1]:8080/x')
    expect(normalizeAddress('app.localhost')).toBe('http://app.localhost/')
    expect(normalizeAddress('demo.test/page')).toBe('http://demo.test/page')
  })

  it('keeps an address that names its scheme', () => {
    expect(normalizeAddress('http://example.com')).toBe('http://example.com/')
    expect(normalizeAddress('https://localhost:5173')).toBe('https://localhost:5173/')
  })

  it('refuses a scheme the pane never opens', () => {
    for (const address of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hello',
      'blob:https://example.com/id',
      'about:blank',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'view-source:https://example.com',
    ]) {
      expect(normalizeAddress(address), address).toBeNull()
    }
  })

  it('refuses what is not an address', () => {
    expect(normalizeAddress('')).toBeNull()
    expect(normalizeAddress('   ')).toBeNull()
    expect(normalizeAddress('two words')).toBeNull()
  })
})

describe('isLocalHost', () => {
  it('names the dev hosts', () => {
    expect(isLocalHost('localhost')).toBe(true)
    expect(isLocalHost('127.0.0.1')).toBe(true)
    expect(isLocalHost('[::1]')).toBe(true)
    expect(isLocalHost('api.test')).toBe(true)
    expect(isLocalHost('example.com')).toBe(false)
  })
})

describe('addressParts', () => {
  it('splits the host from the rest, without the scheme', () => {
    expect(addressParts('https://example.com/a?b=1#c')).toEqual({
      host: 'example.com',
      rest: '/a?b=1#c',
    })
    expect(addressParts('http://localhost:5173')).toEqual({
      host: 'localhost:5173',
      rest: '/',
    })
    expect(addressParts('https://example.com/')).toEqual({ host: 'example.com', rest: '/' })
  })

  it('gives the text the field shows', () => {
    expect(addressText('https://example.com/a')).toBe('example.com/a')
    expect(addressText('http://[::1]:8080/x')).toBe('[::1]:8080/x')
    expect(addressText('about:blank')).toBeNull()
  })
})
