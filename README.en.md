# dsh-web-fetch-open

中文 → [README.md](README.md)

## Is this for you?

DeepSeek Harness ships a `web_fetch` that only accepts public unicast addresses, so all of these fail:

```
Error: URL hostname "localhost" resolves to a non-public IP address   (WEB_BLOCKED_URL)
```

- You want the agent to read a local service (`localhost:3000`, `127.0.0.1`), a LAN device
  (`192.168.x`, `10.x`) or an intranet hostname. Install it.
- You want `file://` paths, or a DNS fake-ip range from Clash / sing-box / Surge
  (`198.18.0.0/15`). Install it.
- You only fetch public pages and never hit cross-origin redirects. Skip it.
- Your machine runs internal services the agent must not touch. Do not install it —
  this really opens them up.

## Quick start

```sh
# 1. clone into ~/.dsh/plugins/dsh-web-fetch-open
git clone https://github.com/gpboyer2/dsh-web-fetch-open.git ~/.dsh/plugins/dsh-web-fetch-open

# 2. register it in the desktop profile
dsh plugin --profile desktop add link:$HOME/.dsh/plugins/dsh-web-fetch-open

# 3. restart DSH
```

The bundled `cordis.patch.yml` points `ctx.web`'s `fetchProvider` at the `http-open`
provider this plugin registers; there is no profile config to edit by hand.

To verify, ask the agent to fetch `http://127.0.0.1:<your local port>/`.

## What it opens up

| Item | Shipped provider | This plugin |
|---|---|---|
| `localhost` / `127.0.0.1` / `[::1]` | refused | allowed |
| Private `10.x` `172.16-31.x` `192.168.x` | refused | allowed |
| Link-local `169.254.x`, CGNAT `100.64/10` | refused | allowed |
| Clash / sing-box / Surge fake-ip `198.18.0.0/15` | refused | allowed |
| `.local` and intranet hostnames | depends on resolution | allowed |
| Cross-origin redirects | refused | followed, up to 10 hops |
| `user:pass@` in the URL | refused | sent as a Basic auth header |
| Missing `Content-Type` | refused | sniffed as html / text |
| Images, PDFs, archives | error | one-line notice with the byte count; bytes never reach the model |
| `file://` paths | unsupported | supported |
| Size / chars / timeout | 5MB / 100k chars / 30s | 20MB / 500k chars / 25s |

## How it works

The plugin registers a fetch provider under the id `http-open` and points
`ctx.web`'s `fetchProvider` at it. The `web_fetch` tool itself is untouched, so the
agent cannot tell the difference.

- No private/reserved-range filtering: only the scheme is checked
  (`http`, `https`, and `file` when enabled).
- Network access still uses the global `fetch`, so `HTTP_PROXY`, `HTTPS_PROXY`,
  `NO_PROXY` and `NODE_USE_ENV_PROXY` from the launch environment keep working —
  public traffic still goes through Clash, and `NO_PROXY` addresses stay direct.
- Redirects are followed manually, up to `maxRedirects`, across origins.
- A missing or unknown `Content-Type` is sniffed from the body.
- Binary detection runs in order: declared text type, declared binary type,
  `file://` extension, UTF-16 BOM, then a NUL probe. A `text/html; charset=utf-16`
  body legitimately contains NUL bytes and is still decoded; an `application/pdf`
  container without NUL is not dumped into the model as text. Binary payloads get
  a short notice carrying the byte count instead of an error.
- `file://` is read straight from disk, with the kind chosen by extension.

## Configuration

Defaults (`DEFAULTS` in `index.js`):

| Option | Default | Meaning |
| --- | --- | --- |
| `maxResponseBytes` | `20000000` | Response body cap in bytes (20MB) |
| `maxBodyChars` | `500000` | Characters handed to the model (500k) |
| `timeoutMs` | `25000` | Per-request timeout |
| `maxRedirects` | `10` | Redirect hop cap |
| `userAgent` | `deepseek-harness/0.0.1` | Request UA, same as the shipped provider |
| `allowFileUrls` | `true` | Whether `file://` is accepted |
| `allowCredentialsInUrl` | `true` | Whether `user:pass@` becomes a Basic auth header |

Override the plugin row in the profile's `cordis.patch.yml`:

```yaml
- id: web-fetch-open
  name: dsh-web-fetch-open
  config:
    maxResponseBytes: 20000000
    maxBodyChars: 500000
    timeoutMs: 25000
    maxRedirects: 10
    allowFileUrls: true
    allowCredentialsInUrl: true
```

## Tests

```sh
npm test
```

Eleven tests, all against a local loopback server and no network: loopback fetch,
cross-origin redirect, missing content type, the binary notice, a UTF-16 body,
`image/svg+xml` kept as text, a `file://` PDF judged by extension, credentials in
the URL, private/CGNAT/fake-ip literals, and the `allowFileUrls: false` refusal.

## Known limits

- **Installing it really does open the intranet.** There is no allowlist and no
  subnet exclusion. Decide whether that is acceptable before using it on a machine
  you do not fully trust.
- **`file://` reads anything the DSH user can read.** No path allowlist either.
- Binary payloads (images, PDFs, archives) return a one-line notice; their bytes
  never reach the model.
- Depends on the `ctx.web` seam and the `fetchProvider` option of DSH 0.2.x; an
  upstream change to that seam needs a matching change here.

## License

MIT. See [LICENSE](LICENSE).
