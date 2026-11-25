# dsh-web-fetch-open

> **Make `web_fetch` reach localhost, the LAN, and `file://` — not just the public internet.**

[English](README.en.md) · [简体中文](README.md)

![DSH](https://img.shields.io/badge/DSH-DeepSeek%20Harness-1F6FEB?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Cordis](https://img.shields.io/badge/Cordis-plugin-FF6B6B?style=flat-square)
![tests](https://img.shields.io/badge/tests-11-brightgreen?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin. DSH's built-in `web_fetch` only accepts public unicast addresses. This plugin registers a fetch provider with no private-network filtering, opening `localhost`, the LAN, fake-ip ranges, and `file://`.

## What it solves

DSH's stock `web_fetch` address validation rejects all of the following:

```
Error: URL hostname "localhost" resolves to a non-public IP address   (WEB_BLOCKED_URL)
```

- Read local services (`localhost:3000`, `127.0.0.1`), LAN devices (`192.168.x`, `10.x`), and intranet domains. Install.
- Read local files under `file://` paths, or read Clash / sing-box / Surge fake-ip ranges (`198.18.0.0/15`). Install.
- Fetch only public web pages, and do not care about cross-origin redirects being rejected. No need to install.
- Your machine runs intranet services the agent should not touch. Do not install — once installed, it can really reach them.

## How it works

The plugin registers a fetch provider with id `http-open` and replaces `ctx.web`'s `fetchProvider`. The `web_fetch` tool itself is unchanged; the agent cannot see a difference.

- No private/reserved-range filtering on addresses: only the protocol is checked (`http` / `https` / `file` when configured).
- Network still uses the global `fetch`, so `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and `NODE_USE_ENV_PROXY` from the launch environment still apply — with Clash running, public traffic still leaves through the proxy, and local addresses in `NO_PROXY` connect directly.
- Redirects are followed manually, up to `maxRedirects` hops, including cross-origin.
- When `Content-Type` is missing or unrecognized, sniff the content.
- Whether content is binary is decided in order: declared text type → declared binary type → `file://` extension → UTF-16 BOM → NUL probe. Text like `text/html; charset=utf-16`, whose body naturally contains NULs, is still decoded as text; a container like `application/pdf` with no NUL is not emitted as text.
- `file://` reads directly from disk; the extension decides html / text.

## Quick start

```sh
# 1. Clone to ~/.dsh/plugins/dsh-web-fetch-open
git clone https://github.com/gpboyer2/dsh-web-fetch-open.git ~/.dsh/plugins/dsh-web-fetch-open

# 2. Register in a profile (CLI-managed profile, such as web / main)
dsh plugin --profile <your-profile> add link:$HOME/.dsh/plugins/dsh-web-fetch-open

# 3. Restart DSH
```

> The `desktop` profile is reserved by DeepSeek Harness.app. The CLI command `dsh plugin --profile desktop …` is rejected. For the desktop app, install from the in-app Plugins page, or manually edit the profile's `dependencies` and add a symlink, then restart.

The bundled `cordis.patch.yml` points `ctx.web`'s `fetchProvider` to the `http-open` registered by this plugin. No manual profile config edit is needed.

**Verify**: ask the agent to fetch `http://127.0.0.1:<your local service port>/` once. If it returns content, it works.

## What it opens up

| Item | Stock provider | This plugin |
|---|---|---|
| `localhost` / `127.0.0.1` / `[::1]` | Reject | Allow |
| Private `10.x` `172.16-31.x` `192.168.x` | Reject | Allow |
| Link-local `169.254.x`, CGNAT `100.64/10` | Reject | Allow |
| Clash / sing-box / Surge fake-ip range `198.18.0.0/15` | Reject | Allow |
| `.local`, intranet domains | Checks resolution result only | Allow |
| Cross-origin redirects | Reject | Follow, up to 10 hops |
| `user:pass@` in URL | Reject | Convert to Basic auth header and send |
| No `Content-Type` | Reject | Sniff html / text from content |
| Images, PDFs, archives, and other binary types | Error | Return a one-line note (with byte count); bytes do not enter context |
| `file://` local files | Not supported | Supported |
| Size / chars / timeout | 5MB / 100k chars / 30s | 20MB / 500k chars / 25s |

## Core features

| Capability | Description |
| --- | --- |
| **Private-network passthrough** | Loopback, private, link-local, CGNAT, and fake-ip ranges are never blocked. |
| **`file://`** | Reads local files directly; the extension decides html / text. |
| **Cross-origin redirects** | Follows up to `maxRedirects` hops itself; does not stop on cross-origin. |
| **Credentials to header** | `user:pass@` in URL becomes `Authorization: Basic`; it is not written into the request line. |
| **Content sniffing** | When `Content-Type` is missing, html / text is decided from content. |
| **Binary not swallowed** | Images, PDFs, and archives return only a one-line note (with byte count); bytes do not enter context. |
| **Encoding awareness** | Checks the declared charset first and recognizes UTF-16 BOM; NUL-bearing text is not misclassified as binary. |
| **Adjustable limits** | Response cap, model character cap, timeout, and UA are all configurable. |

## Configuration

Defaults (`DEFAULTS` in `index.js`):

| Setting | Default | Description |
| --- | --- | --- |
| `maxResponseBytes` | `20000000` | Response body byte cap (20MB). |
| `maxBodyChars` | `500000` | Character cap passed to the model (500k). |
| `timeoutMs` | `25000` | Per-request timeout. |
| `maxRedirects` | `10` | Redirect hop cap. |
| `userAgent` | `deepseek-harness/0.0.1` | Request UA; default matches the stock provider. |
| `allowFileUrls` | `true` | Whether to allow `file://`. |
| `allowCredentialsInUrl` | `true` | Whether to convert `user:pass@` to a Basic auth header. |

To change a value, override the plugin entry in the profile's `cordis.patch.yml`:

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

## Architecture

```
index.js              Fetch provider (http-open): address validation, redirects, decoding, binary detection
cordis.patch.yml      Bundle patch: point ctx.web's fetchProvider to http-open
test/                 11 tests, all on local loopback, no network
```

Design constraint: replace only `fetchProvider`; leave the `web_fetch` tool untouched. Network uses the global `fetch`, so proxy and `NO_PROXY` behavior stays unchanged.

## Development and testing

```sh
npm test
```

11 tests, all on local loopback, no outbound network: loopback address fetch, cross-origin redirect, missing `Content-Type`, binary note, UTF-16 body, `image/svg+xml` as text, `file://` PDF by extension, credentials in URL, private/CGNAT/fake-ip literals, and rejection with `allowFileUrls: false`.

## Known boundaries

- **Installing it means real intranet access.** No allowlist and no subnet exclusion. Think it through first if you need it in an untrusted environment.
- **`file://` reads every file the user running DSH can read**, also with no path allowlist.
- Binary (images, PDFs, archives) returns only a one-line note; bytes do not enter context. When the original file is needed, have the agent download it with bash.
- Depends on the `ctx.web` seam and the `fetchProvider` config item; compatible with DSH 0.2.x. If upstream changes this seam, this plugin must change with it.
- **Restart required to take effect**: the provider is registered at startup.

## License

[MIT](LICENSE)
