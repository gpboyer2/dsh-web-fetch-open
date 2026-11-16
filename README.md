# dsh-web-fetch-open

English → [README.en.md](README.en.md)

## 适合你吗？

DSH 自带的 `web_fetch` 只认公网单播地址。于是这些全被拒：

```
Error: URL hostname "localhost" resolves to a non-public IP address   (WEB_BLOCKED_URL)
```

- 让 agent 读本机服务（`localhost:3000`、`127.0.0.1`）、局域网设备（`192.168.x`、`10.x`）、内网域名。装。
- 让 agent 读 `file://` 路径下的本地文件，或读 Clash / sing-box / Surge 的 fake-ip 段（`198.18.0.0/15`）。装。
- 只抓公网网页，也不在意跨域重定向被拒。不用装。
- 你的机器上跑着不该让 agent 碰的内网服务。别装——装上以后它真能访问到。

## 快速开始

```sh
# 1. 克隆到 ~/.dsh/plugins/dsh-web-fetch-open
git clone https://github.com/gpboyer2/dsh-web-fetch-open.git ~/.dsh/plugins/dsh-web-fetch-open

# 2. 注册到 desktop profile
dsh plugin --profile desktop add link:$HOME/.dsh/plugins/dsh-web-fetch-open

# 3. 重启 DSH
```

包内的 `cordis.patch.yml` 会把 `ctx.web` 的 `fetchProvider` 指到本插件注册的 `http-open`，不用手改 profile 配置。

验证：让 agent 抓一次 `http://127.0.0.1:<你本机服务的端口>/`，能返回内容就通了。

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
| 图片、PDF、压缩包等二进制 | 报错 | 返回一行说明，不报错 |
| `file://` 本地文件 | 不支持 | 支持 |
| 大小 / 字符 / 超时 | 5MB / 10 万字符 / 30s | 20MB / 50 万字符 / 25s |

## 原理

插件注册一个 id 为 `http-open` 的抓取后端，替换 `ctx.web` 的 `fetchProvider`；`web_fetch` 工具本身不动，所以 agent 那边看不出差别。

- 地址不做私网/保留段过滤：只校验协议（`http` / `https` / 按配置的 `file`）。
- 网络仍然走全局 `fetch`，所以启动环境里的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、`NODE_USE_ENV_PROXY` 照旧生效——Clash 开着时外网仍从代理出去，`NO_PROXY` 里的本地地址直连。
- 重定向自己跟，最多 `maxRedirects` 跳，跨域也跟。
- `Content-Type` 缺失或不认识时按内容嗅探；二进制不报错，返回一句说明。
- `file://` 直接从磁盘读，按扩展名决定 html / text。

## 配置

默认值（`index.js` 里的 `DEFAULTS`）：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `maxResponseBytes` | `20000000` | 响应体字节上限（20MB） |
| `maxBodyChars` | `500000` | 交给模型的字符上限（50 万） |
| `timeoutMs` | `25000` | 单次请求超时 |
| `maxRedirects` | `10` | 重定向跳数上限 |
| `userAgent` | `deepseek-harness/0.0.1` | 请求 UA，默认与出厂 provider 一致 |
| `allowFileUrls` | `true` | 是否允许 `file://` |
| `allowCredentialsInUrl` | `true` | 是否把 `user:pass@` 转成 Basic 认证头 |

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

## 测试

```sh
npm test
```

7 条测试，全部跑在本地回环上，不出网：回环地址抓取、跨域重定向、缺 `Content-Type` 与二进制、URL 内凭据、`file://`、私网/CGNAT/fake-ip 字面量、`allowFileUrls: false` 时的拒绝。

## 已知边界

- **装上就是真的能访问内网。** 没有白名单、没有网段排除。要在不可信环境里用，自己先想清楚。
- **`file://` 读的是运行 DSH 那个用户能读的一切文件**，同样没有路径白名单。
- 二进制（图片、PDF、压缩包）只返回一句「这是二进制内容」，不会把字节交给模型。
- 依赖 `ctx.web` 这个接缝与 `fetchProvider` 配置项，适配 DSH 0.2.x；上游改这个接缝就得跟着改。

## 许可证

MIT。全文见 [LICENSE](LICENSE)。
