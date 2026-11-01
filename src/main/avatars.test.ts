import { describe, expect, it, vi } from 'vitest'
import { accountAvatarRequestUrl, avatarRequestUrl, Avatars, type AvatarFetch } from './avatars'

const AVATAR = 'https://avatars.githubusercontent.com/u/266790742?v=4'
const REQUEST = 'https://avatars.githubusercontent.com/u/266790742?v=4&s=64'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

function avatars(answer: () => Response | Promise<Response>) {
  const fetch = vi.fn<AvatarFetch>(async () => answer())
  return { avatars: new Avatars(fetch), fetch }
}

const picture = (body: ConstructorParameters<typeof Response>[0], type: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': type } })

describe('avatarRequestUrl', () => {
  it("asks GitHub's avatar host for 64 px", () => {
    expect(avatarRequestUrl(AVATAR)).toBe(REQUEST)
    expect(avatarRequestUrl('https://avatars.githubusercontent.com/in/5463070?v=4&s=460')).toBe(
      'https://avatars.githubusercontent.com/in/5463070?v=4&s=64',
    )
  })

  it.each([
    'http://avatars.githubusercontent.com/u/1?v=4',
    'https://avatars.githubusercontent.com.example.com/u/1',
    'https://avatars.githubusercontent.com:8443/u/1',
    'https://user:pass@avatars.githubusercontent.com/u/1',
    'https://example.com/u/1',
    'data:image/png;base64,iVBORw0KGgo=',
    'not a url',
    '',
  ])('refuses %j', (url) => {
    expect(avatarRequestUrl(url)).toBeNull()
  })
})

describe('accountAvatarRequestUrl', () => {
  it("takes GitHub's avatars at 96 px and Google's as they are", () => {
    expect(accountAvatarRequestUrl(AVATAR)).toBe(
      'https://avatars.githubusercontent.com/u/266790742?v=4&s=96',
    )
    const google = 'https://lh3.googleusercontent.com/a/ACg8ocK=s96-c'
    expect(accountAvatarRequestUrl(google)).toBe(google)
  })

  it.each([
    'http://lh3.googleusercontent.com/a/x',
    'https://lh3.googleusercontent.com.example.com/a/x',
    'https://drive.googleusercontent.com/x',
    'https://example.com/avatar.png',
    'not a url',
  ])('refuses %j', (url) => {
    expect(accountAvatarRequestUrl(url)).toBeNull()
  })
})

describe('Avatars', () => {
  it('hands a picture over as a data: URL', async () => {
    const { avatars: store, fetch } = avatars(() => picture(PNG, 'image/png'))
    expect(await store.load(AVATAR)).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(fetch).toHaveBeenCalledWith(REQUEST, {
      redirect: 'error',
      signal: expect.any(AbortSignal),
    })
  })

  it.each(['image/jpeg', 'image/gif', 'image/webp', 'IMAGE/PNG; charset=binary'])(
    'takes %s',
    async (type) => {
      const { avatars: store } = avatars(() => picture(PNG, type))
      expect(await store.load(AVATAR)).toMatch(/^data:image\/(jpeg|gif|webp|png);base64,/)
    },
  )

  it('never fetches from another host', async () => {
    const { avatars: store, fetch } = avatars(() => picture(PNG, 'image/png'))
    expect(await store.load('https://example.com/a.png')).toBeNull()
    expect(await store.load('http://avatars.githubusercontent.com/u/1')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['an SVG', () => picture('<svg/>', 'image/svg+xml')],
    ['a page', () => picture('<html></html>', 'text/html')],
    ['no type', () => new Response(PNG)],
    ['a 404', () => picture(null, 'image/png', 404)],
    ['more than 100 KB', () => picture(Buffer.alloc(100 * 1024 + 1), 'image/png')],
    [
      'a failed fetch',
      () => {
        throw new Error('net::ERR_INTERNET_DISCONNECTED')
      },
    ],
  ])('gives null for %s', async (_, answer) => {
    const { avatars: store } = avatars(answer)
    expect(await store.load(AVATAR)).toBeNull()
  })

  it('keeps a picture and shares a load in flight', async () => {
    const { avatars: store, fetch } = avatars(() => picture(PNG, 'image/png'))
    const [first, second] = await Promise.all([store.load(AVATAR), store.load(AVATAR)])
    expect(first).toBe(second)
    expect(await store.load(`${AVATAR}&s=460`)).toBe(first)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('tries again after a failure', async () => {
    let online = false
    const { avatars: store, fetch } = avatars(() => {
      if (!online) throw new Error('net::ERR_INTERNET_DISCONNECTED')
      return picture(PNG, 'image/png')
    })
    expect(await store.load(AVATAR)).toBeNull()
    online = true
    expect(await store.load(AVATAR)).not.toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps at most 200 pictures', async () => {
    const { avatars: store, fetch } = avatars(() => picture(PNG, 'image/png'))
    for (let i = 0; i <= 200; i++) await store.load(`https://avatars.githubusercontent.com/u/${i}`)
    await store.load('https://avatars.githubusercontent.com/u/200')
    expect(fetch).toHaveBeenCalledTimes(201)
    await store.load('https://avatars.githubusercontent.com/u/0')
    expect(fetch).toHaveBeenCalledTimes(202)
  })
})
