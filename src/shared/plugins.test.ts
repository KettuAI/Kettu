import { describe, expect, it } from 'vitest'
import en from './locales/en/marketplace.json'
import zh from './locales/zh-CN/marketplace.json'
import { PLUGIN_PERMISSIONS, describePermission, isPluginPermission } from './plugins'

function text(catalog: unknown, key: string): string | undefined {
  let at = catalog as Record<string, unknown> | string | undefined
  for (const part of key.split('.')) {
    at = typeof at === 'object' ? (at[part] as typeof at) : undefined
  }
  return typeof at === 'string' ? at : undefined
}

describe('describing a permission', () => {
  it('has a name and a description in English and Chinese for every permission', () => {
    const permissions = [...PLUGIN_PERMISSIONS, 'network:api.example.com', 'network:*.example.org']
    for (const permission of permissions) {
      const info = describePermission(permission)!
      expect(info, permission).not.toBeNull()
      for (const catalog of [en, zh]) {
        for (const key of [info.nameKey, info.descriptionKey]) {
          expect(text(catalog, key), `${permission} ${key}`).toBeTruthy()
        }
      }
    }
  })

  it('rates the permissions that read a conversation, answer a request or start a session high', () => {
    for (const permission of ['sessions.content', 'requests.answer', 'sessions.start']) {
      expect(describePermission(permission)!.risk).toBe('high')
    }
    expect(describePermission('sessions.summary')!.risk).toBe('normal')
  })

  it('names the domain of a network permission as declared, a wildcard with its star', () => {
    expect(describePermission('network:api.example.com')!.params).toEqual({
      domain: 'api.example.com',
    })
    expect(describePermission('network:*.example.org')!).toMatchObject({
      params: { domain: '*.example.org' },
      nameKey: 'plugin.permission.networkSubdomains.name',
    })
  })

  it('tells a wildcard permission from the plain one of its base domain', () => {
    const plain = describePermission('network:example.org')!
    const wildcard = describePermission('network:*.example.org')!
    expect(wildcard.params.domain).not.toBe(plain.params.domain)
  })

  it('says nothing of a permission a plugin may not declare', () => {
    for (const permission of ['shell.run', 'network:', 'network:localhost', 'network:*.com.', '']) {
      expect(isPluginPermission(permission), permission).toBe(false)
      expect(describePermission(permission), permission).toBeNull()
    }
  })
})
