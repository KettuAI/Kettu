import { describe, expect, it } from 'vitest'
import { addressParts, addressText, isLocalHost, normalizeAddress, readableRest } from './address'

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

describe('readableRest', () => {
  it('shows escaped characters as characters', () => {
    expect(readableRest('/%E7%BB%9F%E4%B8%80')).toBe('/统一')
    expect(readableRest('/caf%C3%A9?q=caf%c3%a9#caf%C3%A9')).toBe('/café?q=café#café')
    expect(readableRest('/wiki/%E7%BB%9F%E4%B8%80%E8%B5%84%E6%BA%90')).toBe('/wiki/统一资源')
  })

  it('never decodes escaped ASCII', () => {
    expect(readableRest('/a%2Fb%25c%20d')).toBe('/a%2Fb%25c%20d')
    expect(readableRest('/%E7%BB%9F%2F%E4%B8%80')).toBe('/统%2F一')
  })

  it('keeps a run that is not UTF-8 as it is', () => {
    expect(readableRest('/%E7%BB')).toBe('/%E7%BB')
    expect(readableRest('/%E7%BB/%E4%B8%80')).toBe('/%E7%BB/一')
    expect(readableRest('/%FF%FE')).toBe('/%FF%FE')
  })

  it('keeps invisible characters and spaces escaped', () => {
    expect(readableRest('/a%E2%80%AEb')).toBe('/a%E2%80%AEb')
    expect(readableRest('/a%E2%80%8Bb')).toBe('/a%E2%80%8Bb')
    expect(readableRest('/a%C2%A0b')).toBe('/a%C2%A0b')
    expect(readableRest('/%E7%BB%9F%E2%80%8B%E4%B8%80')).toBe('/统%E2%80%8B一')
  })

  it('leaves the rest of the text alone', () => {
    expect(readableRest('/a?b=1&c=2#d')).toBe('/a?b=1&c=2#d')
    expect(readableRest('')).toBe('')
  })
})
