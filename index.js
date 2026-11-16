/**
 * `dsh-web-fetch-open`: an unrestricted `ctx.web` fetch provider for DeepSeek
 * Harness.
 *
 * The shipped `@deepseek-ai/dsh-web-fetch-http` provider refuses any destination
 * that is not public unicast, so `web_fetch` cannot reach `localhost`, a LAN
 * service, a DNS fake-ip range (Clash / sing-box / Surge answer in
 * 198.18.0.0/15), or any other reserved address. It also refuses cross-origin
 * redirects, URLs carrying credentials, and responses whose content type it
 * does not recognise.
 *
 * This provider keeps the same `ctx.web` contract and drops those restrictions:
 * every resolved address is accepted, redirects are followed across origins,
 * unknown or missing content types are sniffed from the body, and `file://`
 * paths are read straight from disk. Network access still goes through the
 * global `fetch`, so the launch environment's `HTTP_PROXY` / `HTTPS_PROXY` /
 * `NO_PROXY` (and `NODE_USE_ENV_PROXY`) keep working exactly as before.
 *
 * The module imports nothing from the harness: a profile-installed plugin cannot
 * resolve the runtime's `@deepseek-ai/*` packages.
 *
 * @module dsh-web-fetch-open
 */

import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Provider id this plugin registers under; never `http`. */
export const OPEN_PROVIDER_ID = 'http-open'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-open'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Default `User-Agent`, matching the shipped provider. */
export const DEFAULT_USER_AGENT = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'

/** Redirect statuses that carry a `Location` header. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** Defaults applied when the plugin row omits a field. */
export const DEFAULTS = {
  maxResponseBytes: 20_000_000,
  maxBodyChars: 500_000,
  timeoutMs: 25_000,
  maxRedirects: 10,
  userAgent: DEFAULT_USER_AGENT,
  allowFileUrls: true,
  allowCredentialsInUrl: true,
}

/** Extensions read as HTML from disk. */
const HTML_EXTENSIONS = new Set(['.html', '.htm', '.xhtml', '.shtml'])

/**
 * Build an error carrying the harness' machine-routable `code`. The runtime's
 * `WebError` class cannot be imported here, so a plain `Error` is tagged.
 *
 * @param {string} message - human readable reason.
 * @param {string} code - `WEB_*` code the harness surfaces.
 * @returns {Error} the tagged error.
 */
export function webError(message, code) {
  const error = new Error(message)
  error.name = 'WebError'
  error.code = code
  return error
}

/**
 * Parse and check a request URL.
 *
 * @param {string} input - raw URL.
 * @param {{ allowFileUrls: boolean, allowCredentialsInUrl: boolean }} limits - resolved policy.
 * @returns {URL} the parsed URL.
 */
export function parseFetchUrl(input, limits = DEFAULTS) {
  if (typeof input !== 'string' || input.length === 0) {
    throw webError(`invalid URL: ${String(input)}`, 'WEB_INVALID_URL')
  }
  let url
  try {
    url = new URL(input)
  } catch {
    throw webError(`invalid URL: ${input}`, 'WEB_INVALID_URL')
  }
  const allowed = url.protocol === 'http:' || url.protocol === 'https:' || (limits.allowFileUrls && url.protocol === 'file:')
  if (!allowed) {
    throw webError(`unsupported URL scheme "${url.protocol}" (http, https${limits.allowFileUrls ? ' and file' : ''} are allowed)`, 'WEB_INVALID_URL')
  }
  if (!limits.allowCredentialsInUrl && (url.username.length > 0 || url.password.length > 0)) {
    throw webError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  return url
}

/**
 * Classify a `Content-Type` header into the body kind the harness renders.
 *
 * @param {string|null} header - raw `Content-Type` value.
 * @returns {'html'|'text'|undefined} the kind, or undefined when it must be sniffed.
 */
export function classifyContentType(header) {
  if (header === null || header.trim() === '') return undefined
  const type = header.split(';')[0].trim().toLowerCase()
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (type.startsWith('text/')) return 'text'
  if (type === 'application/json' || type.endsWith('+json')) return 'text'
  if (type === 'application/xml' || type.endsWith('+xml')) return 'text'
  if (type === 'application/javascript' || type === 'application/x-javascript') return 'text'
  if (type === 'application/x-ndjson' || type === 'text/event-stream') return 'text'
  return undefined
}

/**
 * Read the charset parameter out of a `Content-Type` header.
 *
 * @param {string|null} header - raw `Content-Type` value.
 * @returns {string} the charset label, UTF-8 when absent.
 */
export function charsetOf(header) {
  if (header === null) return 'utf-8'
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/iu.exec(header)
  return match === null ? 'utf-8' : match[1]
}

/**
 * Decode bytes with the declared charset, falling back to UTF-8 rather than
 * failing when the label is unknown.
 *
 * @param {Uint8Array} bytes - body bytes.
 * @param {string} charset - charset label.
 * @returns {string} decoded text.
 */
export function decodeBody(bytes, charset) {
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/**
 * Whether a byte prefix looks like binary data (a NUL byte in the first slice).
 *
 * @param {Uint8Array} bytes - body bytes.
 * @returns {boolean} true when the payload should not be rendered as text.
 */
export function looksBinary(bytes) {
  const limit = Math.min(bytes.byteLength, 1024)
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true
  }
  return false
}

/** Media prefixes that are never text, even when the body carries no NUL byte. */
const BINARY_MEDIA_PREFIXES = ['image/', 'audio/', 'video/', 'font/']

/**
 * Content types rendered as bytes rather than text.
 *
 * `image/svg+xml` is deliberately absent: it is declared with an `image/` prefix
 * but is ordinary text.
 */
const BINARY_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-bzip2',
  'application/x-xz',
  'application/zstd',
  'application/octet-stream',
  'application/wasm',
  'application/java-archive',
  'application/epub+zip',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

/** File extensions read as bytes on `file://`, where no content type exists. */
const BINARY_EXTENSIONS = new Set([
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.zst', '.7z', '.rar', '.tar',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.ico', '.avif', '.heic',
  '.mp3', '.m4a', '.wav', '.flac', '.ogg', '.oga', '.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.epub',
  '.dmg', '.exe', '.msi', '.so', '.dylib', '.dll', '.bin', '.dat',
  '.sqlite', '.db', '.parquet', '.arrow', '.pyc', '.class', '.jar', '.wasm',
])

/**
 * Whether a declared content type is a byte container rather than text.
 *
 * @param {string|null} header - raw `Content-Type` value.
 * @returns {boolean} true when the body must not be decoded as text.
 */
export function isBinaryContentType(header) {
  if (header === null || header.trim() === '') return false
  const type = header.split(';')[0].trim().toLowerCase()
  if (type === 'image/svg+xml') return false
  if (BINARY_CONTENT_TYPES.has(type)) return true
  return BINARY_MEDIA_PREFIXES.some((prefix) => type.startsWith(prefix))
}

/**
 * The charset a UTF-16 byte-order mark implies, if the body carries one.
 *
 * @param {Uint8Array} bytes - body bytes.
 * @returns {'utf-16le'|'utf-16be'|undefined} the implied charset.
 */
export function bomCharsetOf(bytes) {
  if (bytes.byteLength < 2) return undefined
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  return undefined
}

/**
 * Decide whether a payload is binary.
 *
 * A declared text type wins outright: `text/html; charset=utf-16le` legitimately
 * contains NUL bytes, and decoding it as UTF-8 would destroy it. Otherwise the
 * declared content type, the `file://` extension, and finally a NUL probe decide.
 *
 * @param {Uint8Array} bytes - body bytes.
 * @param {string|null} header - raw `Content-Type` value, null for `file://`.
 * @param {string} [extension] - lowercase file extension for `file://` reads.
 * @returns {boolean} true when the body should be reported as undecompiled bytes.
 */
export function isBinaryPayload(bytes, header, extension) {
  if (extension !== undefined && BINARY_EXTENSIONS.has(extension)) return true
  if (classifyContentType(header) !== undefined) return false
  if (isBinaryContentType(header)) return true
  if (bomCharsetOf(bytes) !== undefined) return false
  return looksBinary(bytes)
}

/**
 * Sniff the body kind and text encoding when the response states neither.
 *
 * @param {Uint8Array} bytes - body bytes.
 * @param {string|null} header - raw `Content-Type` value.
 * @returns {{ kind: 'html'|'text', charset: string }} the decision.
 */
export function sniffBody(bytes, header) {
  const declared = classifyContentType(header)
  if (declared !== undefined) return { kind: declared, charset: charsetOf(header) }
  const head = decodeBody(bytes.subarray(0, 1024), charsetOf(header)).trimStart().toLowerCase()
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml') || head.startsWith('<head')) {
    return { kind: 'html', charset: charsetOf(header) }
  }
  return { kind: 'text', charset: charsetOf(header) }
}

/**
 * Race a promise against an abort signal.
 *
 * @template T
 * @param {Promise<T>} promise - in-flight work.
 * @param {AbortSignal} [signal] - cancellation signal.
 * @returns {Promise<T>} the promise result unless the signal aborts first.
 */
function raceWithSignal(promise, signal) {
  if (signal === undefined) return promise
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(webError('web fetch aborted', 'WEB_ABORTED'))
      return
    }
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(webError('web fetch aborted', 'WEB_ABORTED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Read a response body with a byte cap.
 *
 * @param {Response} response - the response to drain.
 * @param {{ maxResponseBytes: number }} limits - byte cap.
 * @returns {Promise<{ bytes: Uint8Array, truncated: boolean }>} capped bytes.
 */
export async function readCappedBytes(response, limits) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limits.maxResponseBytes) {
    throw webError(`response exceeds the maximum of ${limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
  }
  if (response.body === null) return { bytes: new Uint8Array(0), truncated: false }

  const chunks = []
  let total = 0
  let truncated = false
  for await (const chunk of response.body) {
    if (total + chunk.byteLength > limits.maxResponseBytes) {
      const room = limits.maxResponseBytes - total
      if (room > 0) chunks.push(chunk.subarray(0, room))
      total = limits.maxResponseBytes
      truncated = true
      break
    }
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, truncated }
}

/**
 * Build the `Authorization` header a URL's embedded credentials imply, then
 * strip them from the URL so `fetch` accepts it.
 *
 * @param {URL} url - parsed request URL.
 * @returns {Record<string, string>} headers to merge into the request.
 */
function credentialsHeaders(url) {
  if (url.username.length === 0 && url.password.length === 0) return {}
  const raw = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
  const header = { authorization: `Basic ${Buffer.from(raw, 'utf8').toString('base64')}` }
  url.username = ''
  url.password = ''
  return header
}

/**
 * Read a `file://` URL from disk.
 *
 * @param {URL} url - parsed file URL.
 * @param {object} limits - resolved limits.
 * @returns {Promise<object>} the `WebFetchResult`.
 */
async function readFileUrl(url, limits) {
  const path = fileURLToPath(url)
  const info = await stat(path)
  if (info.isDirectory()) {
    throw webError(`"${path}" is a directory, not a readable file`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
  }
  const bytes = await readFile(path)
  const truncated = bytes.byteLength > limits.maxResponseBytes
  const capped = truncated ? bytes.subarray(0, limits.maxResponseBytes) : bytes
  const binary = isBinaryPayload(capped, null, extname(path).toLowerCase())
  return resultOf(url, 200, capped, truncated, sniffBody(capped, null), limits, path, binary)
}

/**
 * Assemble an `WebFetchResult` from capped bytes.
 *
 * @param {URL} url - final URL.
 * @param {number} statusCode - HTTP status (or 200 for files).
 * @param {Uint8Array} bytes - capped body bytes.
 * @param {boolean} truncatedByBytes - whether the byte cap clipped the body.
 * @param {{ kind: 'html'|'text', charset: string }} shape - sniffed body shape.
 * @param {object} limits - resolved limits.
 * @param {string} [binaryLabel] - file path used when the payload is binary.
 * @param {boolean} [binary] - whether the payload is bytes, decided by `isBinaryPayload`.
 * @returns {object} the result value.
 */
function resultOf(url, statusCode, bytes, truncatedByBytes, shape, limits, binaryLabel, binary = false) {
  if (binary) {
    const label = binaryLabel === undefined ? url.href : binaryLabel
    const tail = truncatedByBytes ? `，已截断到前 ${limits.maxResponseBytes} 字节` : ''
    return {
      url: url.href,
      statusCode,
      body: {
        kind: 'text',
        content: `[二进制内容：${label}，共 ${bytes.byteLength} 字节${tail}，未返回字节；需要原文件请用 bash 下载]`,
      },
      truncated: truncatedByBytes,
    }
  }
  let content = decodeBody(bytes, bomCharsetOf(bytes) ?? shape.charset)
  let truncatedByChars = false
  if (content.length > limits.maxBodyChars) {
    content = content.slice(0, limits.maxBodyChars)
    truncatedByChars = true
  }
  return {
    url: url.href,
    statusCode,
    body: { kind: shape.kind, content },
    truncated: truncatedByBytes || truncatedByChars,
  }
}

/** The unrestricted fetch provider. */
export class OpenFetchProvider {
  /**
   * @param {object} limits - resolved transport and response limits.
   */
  constructor(limits) {
    this.id = OPEN_PROVIDER_ID
    this.limits = limits
  }

  /** No credentials to check — this fetcher is always usable. */
  available() {
    return true
  }

  /**
   * Retrieve one URL.
   *
   * @param {{ url: string }} request - the fetch request.
   * @param {AbortSignal} [signal] - cancellation signal.
   * @returns {Promise<object>} the `WebFetchResult`.
   */
  async fetch(request, signal) {
    const timeout = AbortSignal.timeout(this.limits.timeoutMs)
    const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    try {
      const initial = parseFetchUrl(request.url, this.limits)
      if (initial.protocol === 'file:') return await readFileUrl(initial, this.limits)
      return await this.followAndRead(initial, composed)
    } catch (error) {
      if (error?.name === 'TimeoutError') throw webError(`web fetch timed out after ${this.limits.timeoutMs}ms`, 'WEB_FETCH_TIMEOUT')
      if (error?.name === 'AbortError') throw webError('web fetch aborted', signal?.aborted === true ? 'WEB_ABORTED' : 'WEB_FETCH_TIMEOUT')
      if (error?.name === 'WebError') throw error
      throw webError(`fetch failed: ${error?.message ?? String(error)}`, 'WEB_PROVIDER_ERROR')
    }
  }

  /**
   * Follow redirects (any origin) up to the hop cap, then read the last response.
   *
   * @param {URL} initial - validated request URL.
   * @param {AbortSignal} signal - composed cancellation signal.
   * @returns {Promise<object>} the result value.
   */
  async followAndRead(initial, signal) {
    let current = new URL(initial.href)
    let redirects = 0
    for (;;) {
      const extra = credentialsHeaders(current)
      const response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: {
          'user-agent': this.limits.userAgent,
          accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8,*/*;q=0.5',
          ...extra,
        },
      })

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (location === null) return resultOf(current, response.status, new Uint8Array(0), false, { kind: 'text', charset: 'utf-8' }, this.limits, undefined, false)
        if (redirects >= this.limits.maxRedirects) {
          throw webError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
        }
        let next
        try {
          next = new URL(location, current)
        } catch {
          throw webError(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR')
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw webError(`redirect to unsupported scheme "${next.protocol}"`, 'WEB_REDIRECT_BLOCKED')
        }
        current = next
        redirects += 1
        continue
      }

      const header = response.headers.get('content-type')
      const { bytes, truncated } = await readCappedBytes(response, this.limits)
      return resultOf(current, response.status, bytes, truncated, sniffBody(bytes, header), this.limits, undefined, isBinaryPayload(bytes, header))
    }
  }
}

/**
 * Register the unrestricted HTTP(S)/file fetch provider with `ctx.web`.
 *
 * @param {{ web: { registerFetchProvider(provider: unknown): () => void } }} ctx - plugin context.
 * @param {object} [config] - the plugin row's `config`.
 */
export function apply(ctx, config) {
  const resolved = { ...DEFAULTS, ...(config ?? {}) }
  for (const key of ['maxResponseBytes', 'maxBodyChars', 'timeoutMs']) {
    if (!Number.isFinite(resolved[key]) || resolved[key] <= 0) {
      throw new Error(`web-fetch-open: ${key} must be a positive finite number`)
    }
  }
  if (!Number.isInteger(resolved.maxRedirects) || resolved.maxRedirects < 0) {
    throw new Error('web-fetch-open: maxRedirects must be a non-negative integer')
  }
  const limits = {
    maxResponseBytes: resolved.maxResponseBytes,
    maxBodyChars: resolved.maxBodyChars,
    timeoutMs: resolved.timeoutMs,
    maxRedirects: resolved.maxRedirects,
    userAgent: resolved.userAgent,
    allowFileUrls: resolved.allowFileUrls !== false,
    allowCredentialsInUrl: resolved.allowCredentialsInUrl !== false,
  }
  ctx.web.registerFetchProvider(new OpenFetchProvider(limits))
}