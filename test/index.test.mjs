/**
 * Behaviour tests for the unrestricted fetch provider. Run with:
 *   node --test test/*.test.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { DEFAULTS, OpenFetchProvider, parseFetchUrl } from '../index.js'

const limits = { ...DEFAULTS, timeoutMs: 5000 }

function provider() {
  return new OpenFetchProvider(limits)
}

async function withServer(handler, run) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await run(port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('fetches loopback by hostname and by literal address', async () => {
  await withServer(
    (request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body><h1>hello local</h1></body></html>')
    },
    async (port) => {
      for (const host of ['localhost', '127.0.0.1']) {
        const result = await provider().fetch({ url: `http://${host}:${port}/` })
        assert.equal(result.statusCode, 200)
        assert.equal(result.body.kind, 'html')
        assert.match(result.body.content, /hello local/)
      }
    },
  )
})

test('follows a cross-origin redirect', async () => {
  let target
  await withServer(
    (request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('redirect target reached')
    },
    async (targetPort) => {
      target = targetPort
      await withServer(
        (request, response) => {
          response.writeHead(302, { location: `http://localhost:${target}/landed` })
          response.end()
        },
        async (sourcePort) => {
          const result = await provider().fetch({ url: `http://127.0.0.1:${sourcePort}/start` })
          assert.equal(result.statusCode, 200)
          assert.equal(result.body.content, 'redirect target reached')
          assert.equal(new URL(result.url).port, String(target))
        },
      )
    },
  )
})

test('treats a missing content type as html and a binary payload as a notice', async () => {
  await withServer(
    (request, response) => {
      if (request.url === '/html') {
        response.writeHead(200)
        response.end('<!doctype html><html><body>no header</body></html>')
        return
      }
      if (request.url === '/binary') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end(Buffer.from([0x00, 0x01, 0x02, 0x03]))
        return
      }
      response.writeHead(404)
      response.end('missing')
    },
    async (port) => {
      const html = await provider().fetch({ url: `http://localhost:${port}/html` })
      assert.equal(html.body.kind, 'html')

      const binary = await provider().fetch({ url: `http://localhost:${port}/binary` })
      assert.equal(binary.statusCode, 200)
      assert.match(binary.body.content, /二进制内容/)
    },
  )
})

test('sends Basic credentials embedded in the URL', async () => {
  let seen
  await withServer(
    (request, response) => {
      seen = request.headers.authorization
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
    },
    async (port) => {
      await provider().fetch({ url: `http://user:pass@127.0.0.1:${port}/` })
      assert.equal(seen, `Basic ${Buffer.from('user:pass').toString('base64')}`)
    },
  )
})

test('reads a file:// URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-fetch-open-'))
  const file = join(dir, 'page.html')
  await writeFile(file, '<html><body>local file</body></html>', 'utf8')
  const result = await provider().fetch({ url: pathToFileURL(file).href })
  assert.equal(result.statusCode, 200)
  assert.equal(result.body.kind, 'html')
  assert.match(result.body.content, /local file/)
})

test('accepts private, CGNAT and fake-ip literals', () => {
  for (const url of [
    'http://192.168.31.99:8080/x',
    'http://10.0.0.5/',
    'http://198.18.0.7/',
    'http://[::1]:3000/',
    'http://169.254.1.1/',
  ]) {
    assert.equal(parseFetchUrl(url).hostname.length > 0, true)
  }
})

test('rejects a non-http scheme only when file URLs are disabled', () => {
  assert.throws(() => parseFetchUrl('ftp://example.com/', { ...DEFAULTS, allowFileUrls: false }), /unsupported URL scheme/)
  assert.equal(parseFetchUrl('file:///etc/hosts').protocol, 'file:')
})