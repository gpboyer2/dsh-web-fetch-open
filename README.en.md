# dsh-web-fetch-open

> `web_fetch` can read localhost, the LAN, and `file://`, not only the public internet.

[English](README.en.md) · [简体中文](README.md)

![DSH](https://img.shields.io/badge/DSH-DeepSeek%20Harness-1F6FEB?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Cordis](https://img.shields.io/badge/Cordis-plugin-FF6B6B?style=flat-square)
![tests](https://img.shields.io/badge/tests-11-brightgreen?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square)

A DeepSeek Harness (DSH) plugin. The stock `web_fetch` accepts public unicast addresses only. `localhost`, private networks, fake-ip ranges, and `file://` are all rejected:

```
Error: URL hostname "localhost" resolves to a non-public IP address   (WEB_BLOCKED_URL)
```

This plugin registers a fetch provider with no private-network filtering and replaces `ctx.web`'s `fetchProvider`. The `web_fetch` tool itself is unchanged, and the agent sees no difference.

## How it works

- Addresses are not filtered by private or reserved range. Only the protocol is checked (`http` / `https` / `file` when configured).
- The network still goes through the global `fetch`, so `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and `NODE_USE_ENV_PROXY` from the launch environment still apply. With Clash running, public traffic still leaves through the proxy; local addresses in `NO_PROXY` connect directly.
- Redirects are followed by the plugin itself, up to `maxRedirects` hops, cross-origin included.
- When `Content-Type` is missing or unknown, the content is sniffed.
- Whether a body is binary is decided in order: declared text type → declared binary type → `file://` extension → UTF-16 BOM → NUL probe. Text such as `text/html; charset=utf-16`, whose body naturally contains NULs, is still decoded as text. A container such as `application/pdf`, which has no NUL, is not emitted as text.
- `file://` reads straight from disk; the extension decides html or text.

## What it opens up

| Item | Stock provider | This plugin |
|---|---|---|
| `localhost` / `127.0.0.1` / `[::1]` | Reject | Allow |
| Private `10.x` `172.16-31.x` `192.168.x` | Reject | Allow |
| Link-local `169.254.x`, CGNAT `100.64/10` | Reject | Allow |
| Clash / sing-box / Surge fake-ip range `198.18.0.0/15` | Reject | Allow |
| `.local`, intranet domains | Resolution result only | Allow |
| Cross-origin redirects | Reject | Follow, up to 10 hops |
| `user:pass@` in URL | Reject | Convert to a Basic auth header and send |
| No `Content-Type` | Reject | Sniff html / text from content |
| Images, PDFs, archives, and other binary types | Error | Return a one-line note (with byte count); bytes do not enter context |
| `file://` local files | Not supported | Supported |
| Size / chars / timeout | 5MB / 100k chars / 30s | 20MB / 500k chars / 25s |

## Quick start

```sh
# Install straight from GitHub (a CLI-managed profile such as web / main)
dsh plugin --profile <your-profile> add github:gpboyer2/dsh-web-fetch-open

# Local development: clone to ~/.dsh/plugins/dsh-web-fetch-open and install through a local link
git clone https://github.com/gpboyer2/dsh-web-fetch-open.git ~/.dsh/plugins/dsh-web-fetch-open
dsh plugin --profile <your-profile> add link:$HOME/.dsh/plugins/dsh-web-fetch-open

# Restart DSH
```

The `desktop` profile is owned by DeepSeek Harness.app, and the CLI command is rejected. For the desktop app, install from the in-app Plugins page, or edit the profile's `dependencies`, add a symlink, and restart.

The bundled `cordis.patch.yml` points `ctx.web`'s `fetchProvider` at the `http-open` provider registered by this plugin. No manual profile config edit is needed.

Verify: ask the agent to fetch `http://127.0.0.1:<your local service port>/` once. If it returns content, it works.

## Core features

| Capability | Description |
| --- | --- |
| Private-network passthrough | Loopback, private, link-local, CGNAT, and fake-ip ranges are never blocked. |
| `file://` | Reads local files directly; the extension decides html or text. |
| Cross-origin redirects | Follows up to `maxRedirects` hops itself; does not stop on cross-origin. |
| Credentials to header | `user:pass@` in URL becomes `Authorization: Basic`; it is not written into the request line. |
| Content sniffing | When `Content-Type` is missing, html or text is decided from the content. |
| Binary not swallowed | Images, PDFs, and archives return only a one-line note (with byte count). |
| Encoding awareness | Checks the declared charset first and also recognizes a UTF-16 BOM. |
| Adjustable limits | Response cap, character cap, timeout, and UA are all configurable. |

## Configuration

Defaults (`DEFAULTS` in `index.js`):

| Setting | Default | Description |
| --- | --- | --- |
| `maxResponseBytes` | `20000000` | Response body byte cap (20MB). |
| `maxBodyChars` | `500000` | Character cap passed to the model (500k). |
| `timeoutMs` | `25000` | Per-request timeout. |
| `maxRedirects` | `10` | Redirect hop cap. |
| `userAgent` | `deepseek-harness/0.0.1` | Request UA; the default matches the stock provider. |
| `allowFileUrls` | `true` | Whether `file://` is allowed. |
| `allowCredentialsInUrl` | `true` | Whether `user:pass@` is converted to a Basic auth header. |

Override the plugin entry in the profile's `cordis.patch.yml`:

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
index.js              Fetch provider (http-open): address checks, redirects, decoding, binary detection
cordis.patch.yml      Bundle patch: points ctx.web's fetchProvider at http-open
test/                 11 tests, all on local loopback, no network
```

Only `fetchProvider` is replaced; the `web_fetch` tool is not touched. The network goes through the global `fetch`, so proxy and `NO_PROXY` behavior is unchanged.

## Tests

```sh
npm test
```

11 tests, all on local loopback, no outbound network: loopback fetch, cross-origin redirect, missing `Content-Type`, binary note, UTF-16 body, `image/svg+xml` as text, `file://` PDF by extension, credentials in URL, private / CGNAT / fake-ip literals, and rejection with `allowFileUrls: false`.

## Limits

- Once installed, it can really reach the intranet. There is no allowlist and no subnet exclusion, which matters before using it in an untrusted environment.
- `file://` reads every file the user running DSH can read. There is no path allowlist either.
- Binary content (images, PDFs, archives) returns only a one-line note; the bytes do not enter context. When the original file is needed, the agent downloads it with bash.
- Depends on the `ctx.web` seam and the `fetchProvider` config item; written for DSH 0.2.x. If upstream changes this seam, the plugin has to change with it.
- A restart is required: the provider is registered at startup.

## License

[MIT](LICENSE)
