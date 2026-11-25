import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HtmlPreviews } from './html-preview'
import { tempFolder } from './testing/temp'

const platform = process.platform === 'win32' ? 'win32' : 'darwin'

let previews: HtmlPreviews | null = null

afterEach(async () => {
  await previews?.stop()
  previews = null
})

async function setup() {
  const base = await realpath(await tempFolder('kettu-preview-'))
  const root = path.join(base, 'project')
  const outside = path.join(base, 'outside')
  await mkdir(path.join(root, 'assets', 'img'), { recursive: true })
  await mkdir(path.join(root, '.git'), { recursive: true })
  await mkdir(path.join(root, 'site', '.hidden'), { recursive: true })
  await mkdir(outside)
  await writeFile(path.join(root, 'index.html'), '<link rel="stylesheet" href="style.css">')
  await writeFile(path.join(root, 'style.css'), 'body { color: red }')
  await writeFile(path.join(root, 'app.js'), 'console.log(1)')
  await writeFile(path.join(root, 'assets', 'img', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e]))
  await writeFile(path.join(root, '.env'), 'SECRET=1')
  await writeFile(path.join(root, '.git', 'config'), '[core]')
  await writeFile(path.join(root, 'site', '.hidden', 'page.html'), '<p>hidden</p>')
  await writeFile(path.join(outside, 'secret.txt'), 'outside')
  const folders = new Map<string, string | null>([['s1', root]])
  previews = new HtmlPreviews({
    platform,
    folderOf: (sessionId) => folders.get(sessionId) ?? null,
    log: () => {},
  })
  const url = new URL(await previews.url('s1', 'index.html'))
  const token = url.pathname.split('/')[1]!
  return { root, outside, folders, previews, url, token, port: Number(url.port) }
}

interface Answer {
  status: number
  type: string | undefined
  body: string
  headers: http.IncomingHttpHeaders
}

/** A request with its path sent as written, which `fetch` would normalize first. */
function send(
  port: number,
  target: string,
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: target, method, headers },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            type: response.headers['content-type'],
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers,
          }),
        )
      },
    )
    request.on('error', reject)
    request.end()
  })
}

describe('HtmlPreviews', () => {
  it('serves the file and the files it loads, each with its type', async () => {
    const { url, token, port } = await setup()
    expect(url.hostname).toBe('127.0.0.1')
    expect(url.pathname).toBe(`/${token}/index.html`)
    const page = await send(port, url.pathname)
    expect(page.status).toBe(200)
    expect(page.type).toBe('text/html; charset=utf-8')
    expect(page.body).toContain('style.css')
    // Never kept, so a reload shows the file as it is now.
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.headers['referrer-policy']).toBe('no-referrer')
    expect(page.headers['x-content-type-options']).toBe('nosniff')
    expect(page.headers['access-control-allow-origin']).toBeUndefined()

    const css = await send(port, `/${token}/style.css`)
    expect(css.status).toBe(200)
    expect(css.type).toBe('text/css; charset=utf-8')
    expect(css.body).toBe('body { color: red }')
    expect((await send(port, `/${token}/app.js?v=2`)).type).toBe('text/javascript; charset=utf-8')
    const image = await send(port, `/${token}/assets/img/logo.png`)
    expect(image.status).toBe(200)
    expect(image.type).toBe('image/png')
    expect(image.headers['content-length']).toBe('3')
  })

  it('reads a name written with escapes', async () => {
    const { root, token, port } = await setup()
    await writeFile(path.join(root, 'a b.css'), 'x')
    expect((await send(port, `/${token}/a%20b.css`)).status).toBe(200)
  })

  it('gives each session one token, and none to a session it does not know', async () => {
    const { previews, folders, root, url } = await setup()
    await writeFile(path.join(root, 'about.htm'), '<p>about</p>')
    expect(new URL(await previews.url('s1', 'about.htm')).pathname.split('/')[1]).toBe(
      url.pathname.split('/')[1],
    )
    folders.set('s2', root)
    const other = new URL(await previews.url('s2', 'index.html'))
    expect(other.port).toBe(url.port)
    expect(other.pathname).not.toBe(url.pathname)
    await expect(previews.url('nobody', 'index.html')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('refuses a wrong or missing token', async () => {
    const { port } = await setup()
    expect((await send(port, '/index.html')).status).toBe(404)
    expect((await send(port, '/')).status).toBe(404)
    expect((await send(port, `/${'x'.repeat(32)}/index.html`)).status).toBe(404)
  })

  it('serves nothing outside the folder', async () => {
    const { root, outside, token, port } = await setup()
    expect((await send(port, `/${token}/../outside/secret.txt`)).status).toBe(404)
    expect((await send(port, `/${token}/%2e%2e/outside/secret.txt`)).status).toBe(404)
    expect((await send(port, `/${token}/%2E%2E%2Foutside%2Fsecret.txt`)).status).toBe(404)
    expect((await send(port, `/${token}/assets/..%2f..%2foutside/secret.txt`)).status).toBe(404)
    expect((await send(port, `/${token}/${encodeURIComponent(outside)}/secret.txt`)).status).toBe(
      404,
    )
    expect((await send(port, `/${token}//etc/hosts`)).status).toBe(404)
    expect((await send(port, `/${token}/%00index.html`)).status).toBe(404)
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'linked.txt'))
    await symlink(outside, path.join(root, 'linked-folder'))
    expect((await send(port, `/${token}/linked.txt`)).status).toBe(404)
    expect((await send(port, `/${token}/linked-folder/secret.txt`)).status).toBe(404)
  })

  it('serves no dot file and nothing in a dot folder, whatever the path', async () => {
    const { root, token, port, previews } = await setup()
    expect((await send(port, `/${token}/.env`)).status).toBe(404)
    expect((await send(port, `/${token}/%2eenv`)).status).toBe(404)
    expect((await send(port, `/${token}/.git/config`)).status).toBe(404)
    expect((await send(port, `/${token}/site/.hidden/page.html`)).status).toBe(404)
    expect((await send(port, `/${token}/site/%2Ehidden/page.html`)).status).toBe(404)
    // A link with an ordinary name still leads to the dot file.
    await symlink(path.join(root, '.env'), path.join(root, 'env.txt'))
    expect((await send(port, `/${token}/env.txt`)).status).toBe(404)
    await expect(previews.url('s1', 'site/.hidden/page.html')).rejects.toMatchObject({
      code: 'invalid_params',
    })
  })

  it('lists no folder', async () => {
    const { token, port } = await setup()
    for (const target of [`/${token}`, `/${token}/`, `/${token}/assets`, `/${token}/assets/`]) {
      const answer = await send(port, target)
      expect(answer.status).toBe(404)
      expect(answer.body).not.toContain('img')
    }
  })

  it('answers only GET and HEAD', async () => {
    const { token, port } = await setup()
    const head = await send(port, `/${token}/style.css`, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
      const answer = await send(port, `/${token}/style.css`, method)
      expect(answer.status).toBe(405)
      expect(answer.headers.allow).toBe('GET, HEAD')
    }
  })

  it('refuses a request for another host name, as a rebound domain would send', async () => {
    const { token, port } = await setup()
    const answer = await send(port, `/${token}/style.css`, 'GET', { host: `evil.test:${port}` })
    expect(answer.status).toBe(403)
    expect((await send(port, `/${token}/style.css`, 'GET', { host: 'localhost' })).status).toBe(403)
  })

  it('ends a session’s token with the session', async () => {
    const { previews, folders, token, port } = await setup()
    previews.end(['s1'])
    expect((await send(port, `/${token}/style.css`)).status).toBe(404)
    // A preview asked for again gets a new token.
    const again = new URL(await previews.url('s1', 'index.html'))
    expect(again.pathname.split('/')[1]).not.toBe(token)
    expect((await send(port, again.pathname)).status).toBe(200)
    // A session gone from the host has its token refused too.
    folders.set('s1', null)
    expect((await send(port, again.pathname)).status).toBe(404)
  })

  it('takes only an HTML file of the folder for a preview', async () => {
    const { previews } = await setup()
    await expect(previews.url('s1', 'style.css')).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(previews.url('s1', 'missing.html')).rejects.toMatchObject({ code: 'not_found' })
    await expect(previews.url('s1', '../outside/a.html')).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(previews.url('s1', '.hidden.html')).rejects.toMatchObject({
      code: 'invalid_params',
    })
  })

  it('names the file’s path with escapes', async () => {
    const { previews, root, port } = await setup()
    await mkdir(path.join(root, 'docs page'))
    await writeFile(path.join(root, 'docs page', 'a#b%c.html'), '<p>x</p>')
    const url = new URL(await previews.url('s1', 'docs page/a#b%c.html'))
    expect(url.search).toBe('')
    expect(url.hash).toBe('')
    expect((await send(port, url.pathname)).body).toBe('<p>x</p>')
  })

  it('listens on the loopback address only', async () => {
    const { port } = await setup()
    const other = Object.values(os.networkInterfaces())
      .flat()
      .find((address) => address && address.family === 'IPv4' && !address.internal)
    if (!other) return
    const reached = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: other.address, port }, () => {
        socket.destroy()
        resolve(true)
      })
      socket.on('error', () => resolve(false))
    })
    expect(reached).toBe(false)
  })

  it('stops with every token', async () => {
    const { previews, url, port } = await setup()
    await previews.stop()
    await expect(send(port, url.pathname)).rejects.toThrow()
  })
})
