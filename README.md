# dsh-web-fetch-open

> **让 `web_fetch` 读得到本机、局域网和 `file://`，不再只认公网。**

[简体中文](README.md) · [English](README.en.md)

![DSH](https://img.shields.io/badge/DSH-DeepSeek%20Harness-1F6FEB?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Cordis](https://img.shields.io/badge/Cordis-plugin-FF6B6B?style=flat-square)
![tests](https://img.shields.io/badge/tests-11-brightgreen?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件。DSH 自带的 `web_fetch` 只认公网单播地址，本插件注册一个不做私网过滤的抓取后端，把 `localhost`、局域网、fake-ip 段和 `file://` 都放开。

## 它解决什么问题

DSH 出厂 `web_fetch` 的地址校验会把下面这些全拒掉：

```
Error: URL hostname "localhost" resolves to a non-public IP address   (WEB_BLOCKED_URL)
```

- 让 agent 读本机服务（`localhost:3000`、`127.0.0.1`）、局域网设备（`192.168.x`、`10.x`）、内网域名。装。
- 让 agent 读 `file://` 路径下的本地文件，或读 Clash / sing-box / Surge 的 fake-ip 段（`198.18.0.0/15`）。装。
- 只抓公网网页，也不在意跨域重定向被拒。不用装。
- 你的机器上跑着不该让 agent 碰的内网服务。别装——装上以后它真能访问到。

## 工作原理

插件注册一个 id 为 `http-open` 的抓取后端，替换 `ctx.web` 的 `fetchProvider`；`web_fetch` 工具本身不动，agent 那边看不出差别。

- 地址不做私网/保留段过滤：只校验协议（`http` / `https` / 按配置的 `file`）。
- 网络仍走全局 `fetch`，所以启动环境里的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、`NODE_USE_ENV_PROXY` 照旧生效——Clash 开着时外网仍从代理出去，`NO_PROXY` 里的本地地址直连。
- 重定向自己跟，最多 `maxRedirects` 跳，跨域也跟。
- `Content-Type` 缺失或不认识时按内容嗅探。
- 是否二进制按「声明的文本类型 → 声明的二进制类型 → `file://` 扩展名 → UTF-16 BOM → NUL 探测」依次判定：`text/html; charset=utf-16` 这种正文里天然带 NUL 的文本仍按文本解码，`application/pdf` 这种没有 NUL 的容器也不会被当文本吐出来。
- `file://` 直接从磁盘读，按扩展名决定 html / text。

## 快速开始

```sh
# 1. 克隆到 ~/.dsh/plugins/dsh-web-fetch-open
git clone https://github.com/gpboyer2/dsh-web-fetch-open.git ~/.dsh/plugins/dsh-web-fetch-open

# 2. 注册到 profile（命令行管理的 profile，如 web / main）
dsh plugin --profile <你的profile> add link:$HOME/.dsh/plugins/dsh-web-fetch-open

# 3. 重启 DSH
```

> `desktop` profile 由 DeepSeek Harness.app 独占，命令行 `dsh plugin --profile desktop …` 会被拒。桌面版在应用内「插件」页安装，或手动改 profile 的 `dependencies` + 软链后重启。

包内的 `cordis.patch.yml` 会把 `ctx.web` 的 `fetchProvider` 指到本插件注册的 `http-open`，不用手改 profile 配置。

**验证**：让 agent 抓一次 `http://127.0.0.1:<你本机服务的端口>/`，能返回内容就通了。

## 放开的东西

| 项 | 出厂 provider | 本插件 |
|---|---|---|
| `localhost` / `127.0.0.1` / `[::1]` | 拒绝 | 允许 |
| 私网 `10.x` `172.16-31.x` `192.168.x` | 拒绝 | 允许 |
| 链路本地 `169.254.x`、CGNAT `100.64/10` | 拒绝 | 允许 |
| Clash / sing-box / Surge 的 fake-ip 段 `198.18.0.0/15` | 拒绝 | 允许 |
| `.local`、内网域名 | 只看解析结果 | 允许 |
| 跨域重定向 | 拒绝 | 跟随，最多 10 跳 |
| URL 里带 `user:pass@` | 拒绝 | 转成 Basic 认证头发送 |
| 没有 `Content-Type` | 拒绝 | 按内容嗅探 html / text |
| 图片、PDF、压缩包等二进制 | 报错 | 返回一行说明（含字节数），字节不进上下文 |
| `file://` 本地文件 | 不支持 | 支持 |
| 大小 / 字符 / 超时 | 5MB / 10 万字符 / 30s | 20MB / 50 万字符 / 25s |

## 核心功能

| 能力 | 说明 |
| --- | --- |
| **私网直通** | 回环、私网、链路本地、CGNAT、fake-ip 段一律不拦。 |
| **`file://`** | 直接读本地文件，按扩展名决定 html / text。 |
| **跨域重定向** | 自己跟最多 `maxRedirects` 跳，不因跨域中断。 |
| **凭据转头** | URL 里的 `user:pass@` 转成 `Authorization: Basic`，不写进请求行。 |
| **内容嗅探** | 缺 `Content-Type` 时按内容判 html / text。 |
| **二进制不吞** | 图片、PDF、压缩包只返回一句说明（含字节数），字节不进上下文。 |
| **编码感知** | 先看声明的字符集，UTF-16 BOM 也认，不会把带 NUL 的文本误判成二进制。 |
| **容量可调** | 响应上限、交给模型的字符上限、超时、UA 都能配。 |

## 配置

默认值（`index.js` 里的 `DEFAULTS`）：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `maxResponseBytes` | `20000000` | 响应体字节上限（20MB）。 |
| `maxBodyChars` | `500000` | 交给模型的字符上限（50 万）。 |
| `timeoutMs` | `25000` | 单次请求超时。 |
| `maxRedirects` | `10` | 重定向跳数上限。 |
| `userAgent` | `deepseek-harness/0.0.1` | 请求 UA，默认与出厂 provider 一致。 |
| `allowFileUrls` | `true` | 是否允许 `file://`。 |
| `allowCredentialsInUrl` | `true` | 是否把 `user:pass@` 转成 Basic 认证头。 |

要改就在 profile 的 `cordis.patch.yml` 里覆盖插件行：

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

## 架构

```
index.js              抓取后端（http-open）：地址校验、重定向、解码、二进制判定
cordis.patch.yml      bundle patch：把 ctx.web 的 fetchProvider 指到 http-open
test/                 11 条测试，全部跑在本地回环，不出网
```

设计约束：只替换 `fetchProvider`，不动 `web_fetch` 工具；网络走全局 `fetch`，代理与 `NO_PROXY` 行为保持不变。

## 开发与测试

```sh
npm test
```

11 条，全部跑在本地回环上，不出网：回环地址抓取、跨域重定向、缺 `Content-Type`、二进制说明、UTF-16 正文、`image/svg+xml` 按文本、`file://` 的 PDF 按扩展名、URL 内凭据、私网/CGNAT/fake-ip 字面量、`allowFileUrls: false` 时的拒绝。

## 已知边界

- **装上就是真的能访问内网。** 没有白名单、没有网段排除。要在不可信环境里用，自己先想清楚。
- **`file://` 读的是运行 DSH 那个用户能读的一切文件**，同样没有路径白名单。
- 二进制（图片、PDF、压缩包）只返回一句说明，字节不进上下文；需要原文件时让 agent 用 bash 下载。
- 依赖 `ctx.web` 这个接缝与 `fetchProvider` 配置项，适配 DSH 0.2.x；上游改这个接缝就得跟着改。
- **必须重启才生效**：provider 是启动时注册的。

## 许可证

[MIT](LICENSE)
