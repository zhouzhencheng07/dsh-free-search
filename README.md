[English](README.en.md) | 中文

# dsh-free-search

面向 DeepSeek Harness (dsh) 的**免费多源网页搜索插件**。

注册为 dsh 原生 `web` seam 的 search provider:内置 `web_search` 工具直接走本插件的免费引擎链,
**保留引用卡片 UI**,并且不再消耗 DeepSeek API 额度(替换了 base 层默认的付费
`deepseek-official` 路由——那是一次模型调用/次搜索)。

## 引擎链(全部免费,自动故障转移)

| 引擎 | 类型 | 触发条件 | 备注 |
|---|---|---|---|
| GitHub Search API | 无 key | 查询含 repo/仓库/`owner/repo` 或 github.com 链接 | 代码/仓库检索 |
| arXiv API | 无 key | 查询含 arxiv/预印本/preprint 或 arXiv ID(如 `arxiv 1706.03762`) | 论文直达/检索 |
| StackExchange API | 无 key | 查询含 stackoverflow 等 | 编程问答 |
| Hacker News (Algolia) | 无 key | 查询含 hacker news 等 | 科技新闻 |
| **Tavily** | **keyless 免注册**;有 key 用 key | 始终参与(主引擎) | key 模式解锁 answer 摘要 |
| Sogou 网页搜索 | 无 key(HTML) | 始终参与(兜底) | 中文搜索兜底,自动解析跳转链接 |

优先级:命中的专用引擎优先,随后 Tavily keyless → Sogou;某个引擎失败自动切下一个,
全部失败时报出逐个尝试明细。可选环境变量:`TAVILY_API_KEY`(有则用 key 模式)。

> 说明:Baidu 新版 SERP 是 JS 渲染(静态 HTML 无结果),无法程序化抓取,故未纳入;
> Exa/Brave/Google 等免费 API 在当前网络不可达,亦未纳入。

## 安装

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-free-search"
```

本包声明了 `dsh.bundle.patch`,因此会被激活为 profile 的 bundle 层(而不是仅仅装成
一个不生效的普通依赖)。安装后重启 `dsh web`,内置 `web_search` 即走免费引擎链。

### 本地开发安装

```bash
# 本地开发安装:把路径换成你自己的本地检出目录
dsh plugin --profile web add "file:/path/to/dsh-free-search"
```

> 如果你之前是用 `--patch ./scratch-plugin/...` 参数加载本插件的,请从启动命令中
> 去掉该参数——现在由 bundle 持有 `free-search` 行,重复 insert 会导致启动失败。

## 工作原理

- `src/web-search.js`:`ctx.web.registerSearchProvider({ id: 'free-search', ... })`。
- `src/engine-chain.js`:引擎优先级、查询路由(专用引擎按查询特征参与)、故障转移、
  超时与取消(`AbortSignal` 透传)。
- `src/engines/*.js`:各引擎的请求与输出规范化,统一为
  `{ url, title?, snippet?, publishedAt? }` 列表。
- `cordis.patch.yml`:把 `web` 行 `searchProvider` 从 `deepseek-official` 改为
  `free-search`(该行 config 仅此一个 base key,整体替换安全;profile 层 patch 可改回)。

## 环境要求

- Node.js ≥ 22(dsh 自身要求)
- 无任何 API key 要求;纯 ESM、零依赖、零构建

## 许可证

MIT
