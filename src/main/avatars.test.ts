import { describe, expect, it } from 'vitest'
import { accountAvatarRequestUrl } from './avatars'

const SERVICE = 'https://www.kettu.sh'
const ACCOUNT = '3f2b8c1e-5d4a-4b6f-9e7c-1a2b3c4d5e6f'
const NAME = '0123456789abcdef0123456789abcdef'
const uploaded = (origin: string, ext = 'webp') =>
  `${origin}/api/v1/avatars/${ACCOUNT}/${NAME}.${ext}`

describe('accountAvatarRequestUrl', () => {
  it("takes GitHub's avatars at 96 px and Google's as they are", () => {
    expect(
      accountAvatarRequestUrl('https://avatars.githubusercontent.com/u/266790742?v=4', SERVICE),
    ).toBe('https://avatars.githubusercontent.com/u/266790742?v=4&s=96')
    const google = 'https://lh3.googleusercontent.com/a/ACg8ocK=s96-c'
    expect(accountAvatarRequestUrl(google, SERVICE)).toBe(google)
  })

  it.each(['png', 'jpg', 'webp'])('takes a %s picture uploaded to the account service', (ext) => {
    const url = uploaded(SERVICE, ext)
    expect(accountAvatarRequestUrl(url, SERVICE)).toBe(url)
  })

  it('takes the uploaded pictures of the service a development run signs in to', () => {
    const local = uploaded('http://localhost:8787', 'png')
    expect(accountAvatarRequestUrl(local, 'http://localhost:8787')).toBe(local)
    const nested = uploaded('https://example.com/kettu')
    expect(accountAvatarRequestUrl(nested, 'https://example.com/kettu')).toBe(nested)
    expect(
      accountAvatarRequestUrl(uploaded('https://example.com'), 'https://example.com/kettu'),
    ).toBeNull()
    expect(accountAvatarRequestUrl(uploaded('http://localhost:8787'), SERVICE)).toBeNull()
  })

  it.each([
    'http://lh3.googleusercontent.com/a/x',
    'https://lh3.googleusercontent.com.example.com/a/x',
    'https://drive.googleusercontent.com/x',
    'https://example.com/avatar.png',
    uploaded('http://www.kettu.sh'),
    uploaded('https://kettu.sh'),
    uploaded('https://www.kettu.sh:8443'),
    uploaded('https://www.kettu.sh.example.com'),
    uploaded('https://user:pass@www.kettu.sh'),
    uploaded(SERVICE, 'svg'),
    `${uploaded(SERVICE)}?v=1`,
    `${uploaded(SERVICE)}#top`,
    `${uploaded(SERVICE)}/x`,
    `${SERVICE}/api/v1/avatars/${ACCOUNT}/${NAME}`,
    `${SERVICE}/api/v1/avatars/${ACCOUNT}/${NAME.slice(1)}.webp`,
    `${SERVICE}/api/v1/avatars/${ACCOUNT.toUpperCase()}/${NAME}.webp`,
    `${SERVICE}/api/v1/avatars/x/../${ACCOUNT}/${NAME}.webp/..`,
    `${SERVICE}/api/v1/avatars/${ACCOUNT}/../../me`,
    `${SERVICE}/api/v1/me`,
    'not a url',
    '',
  ])('refuses %j', (url) => {
    expect(accountAvatarRequestUrl(url, SERVICE)).toBeNull()
  })
})
